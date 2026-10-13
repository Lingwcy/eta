import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "effect";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createBotApplication, type BotApplication } from "./application.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(maximum = 1) {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-schedule-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspaces");
  const cwd = join(workspaceRoot, "repo");
  await mkdir(cwd, { recursive: true });
  const slow = fauxProvider({
    provider: "schedule-bot",
    models: [{ id: "one" }],
    tokensPerSecond: 1,
  });
  const fast = fauxProvider({
    provider: "schedule-bot",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  slow.setResponses([fauxAssistantMessage("Deliberately running ordinary work ".repeat(100))]);
  fast.setResponses([fauxAssistantMessage("Scheduled work complete")]);
  let holding = true;
  const models = createModels();
  models.setProvider({
    ...fast.provider,
    streamSimple: (model, context, options) =>
      (holding ? slow : fast).provider.streamSimple(model, context, options),
  });
  const config = {
    dataRoot: join(root, "data"),
    workspaceRoot,
    adminToken: "schedule-test-token",
    maxConcurrent: maximum,
    runtime: { defaultThinkingLevel: "off" as const },
  };
  const open = async () => {
    const bot = await createBotApplication(config, { models });
    cleanups.push(() => bot.close());
    return bot;
  };
  const bot = await open();
  const workspace = [...bot.workspaceProjects.keys()][0];
  const thread = async (name: string) => {
    const created = await bot.core.createThread(workspace);
    await bot.core.renameThread(created.id, name);
    return created.id;
  };
  return {
    bot,
    root,
    fast,
    open,
    thread,
    releaseModel: () => {
      holding = false;
    },
  };
}

async function approvedSchedule(bot: BotApplication, threadId: string) {
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const proposed = await bot.core.proposeScheduleChange({
    threadId,
    requestId: "propose",
    sourceIdentity: "root:tool",
    change: {
      action: "create",
      name: "Review",
      prompt: "Scheduled review",
      rule: { type: "once", at: now + 200 },
    },
  });
  const proposal = (await bot.core.listScheduleProposals({ threadId }))[0];
  expect(proposed.proposalId).toBe(proposal.id);
  expect(await bot.core.listSchedules({ threadId })).toEqual([]);
  const approved = await bot.core.approveScheduleProposal({
    proposalId: proposal.id,
    contentFingerprint: proposal.contentFingerprint,
    requestId: "approve",
  });
  expect(approved.state).toBe("applied");
  return approved.scheduleId!;
}

test("automatic scheduling respects same-project exclusion and wakes when Controller releases capacity", async () => {
  const { bot, thread, releaseModel } = await fixture(4);
  const ordinary = await thread("Ordinary work");
  const scheduled = await thread("Scheduled work");
  await bot.controller.submit(ordinary, "Keep running ordinary work", "ordinary");
  const scheduleId = await approvedSchedule(bot, scheduled);
  await expect
    .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.reason, {
      timeout: 5000,
    })
    .toBe("busy");
  expect(
    (await bot.core.openThread(scheduled)).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ),
  ).toHaveLength(0);
  expect(bot.controller.status().activeThreads).toContain(ordinary);
  releaseModel();
  await bot.controller.stop(ordinary);
  await expect
    .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.state, {
      timeout: 5000,
    })
    .toBe("succeeded");
  expect(
    (await bot.core.openThread(scheduled)).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ),
  ).toHaveLength(1);
  expect(bot.controller.status().activeThreads).toEqual([]);
}, 15000);

test("scheduled admission also obeys maxConcurrent across different projects", async () => {
  const { bot, root, thread, releaseModel } = await fixture();
  const ordinary = await thread("Ordinary work");
  const otherCwd = join(root, "workspaces", "other");
  await mkdir(otherCwd);
  const otherProject = await bot.core.registerProject(otherCwd);
  const otherWorkspace = (await bot.core.workspaces(otherProject.id))[0];
  const scheduled = (await bot.core.createThread(otherWorkspace.id)).id;
  await bot.core.renameThread(scheduled, "Other project scheduled work");
  await bot.controller.submit(ordinary, "Hold all capacity", "ordinary");
  const scheduleId = await approvedSchedule(bot, scheduled);
  await expect
    .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.reason, {
      timeout: 5000,
    })
    .toBe("busy");
  expect(bot.controller.status().activeThreads).toEqual([ordinary]);
  releaseModel();
  await bot.controller.stop(ordinary);
  await expect
    .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.state, {
      timeout: 5000,
    })
    .toBe("succeeded");
}, 15000);

test("Core scheduling boundaries reject workspaces outside Bot scope before persisting proposals", async () => {
  const { bot, root } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  const project = await bot.core.registerProject(outside);
  const workspace = (await bot.core.workspaces(project.id))[0];
  const thread = await bot.core.createThread(workspace.id);
  const input = {
    threadId: thread.id,
    requestId: "outside",
    sourceIdentity: "root:tool",
    change: {
      action: "create" as const,
      name: "Outside",
      prompt: "Outside prompt",
      rule: { type: "interval" as const, everyMs: 300_000, anchorAt: 0 },
    },
  };
  await expect(bot.core.proposeScheduleChange(input)).rejects.toMatchObject({
    code: "WorkspaceUnavailable",
  });
  expect(await bot.core.listScheduleProposals({ threadId: thread.id })).toEqual([]);
  expect(await bot.core.listSchedules({ threadId: thread.id })).toEqual([]);
});

test("Bot root tool waits for authenticated HTTP confirmation before automatic Controller delivery", async () => {
  const { bot, thread, fast, releaseModel } = await fixture();
  releaseModel();
  const id = await thread("Tool schedule");
  fast.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "schedule",
        {
          action: "create",
          name: "Review",
          prompt: "Scheduled review",
          rule: { type: "interval", everyMs: 300_000, anchorAt: Date.now() + 1500 },
        },
        { id: "plan" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Waiting for confirmation"),
  ]);
  await bot.controller.submit(id, "Plan a review", "ordinary");
  await expect
    .poll(async () => (await bot.core.listScheduleProposals({ threadId: id })).length, {
      timeout: 5000,
    })
    .toBe(1);
  await expect.poll(() => bot.controller.status().activeThreads.length).toBe(0);
  expect(await bot.core.listSchedules({ threadId: id })).toEqual([]);
  const proposal = (await bot.core.listScheduleProposals({ threadId: id }))[0];
  fast.setResponses([fauxAssistantMessage("Scheduled review finished")]);
  const response = await bot.app.request(`/v1/schedule-proposals/${proposal.id}/approve`, {
    method: "POST",
    headers: { authorization: "Bearer schedule-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "approve-from-http",
      contentFingerprint: proposal.contentFingerprint,
    }),
  });
  expect(response.status).toBe(200);
  const schedule = (await bot.core.listSchedules({ threadId: id }))[0];
  await expect
    .poll(async () => (await bot.core.listScheduleRuns({ scheduleId: schedule.id }))[0]?.state, {
      timeout: 8000,
    })
    .toBe("succeeded");
  const messages = (await bot.core.openThread(id)).snapshot.transcript.filter(
    (entry) => entry.message.role === "user",
  );
  expect(messages).toHaveLength(2);
  expect(JSON.stringify(messages[1])).toContain("Scheduled review");
}, 15000);
