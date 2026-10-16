import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";

// Only the controlled model is bundled here. The host, Controller, scheduler and tools come from the distribution.
const distribution = resolve(process.argv[2]);
const { createBotApplication } = await import(
  pathToFileURL(join(distribution, "runtime.mjs")).href
);
const root = await mkdtemp(join(tmpdir(), "eta-native-scheduled-bot-"));
let bot;
const poll = async (read, expected, { onTimeout } = {}) => {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (value === expected) return;
    if (Date.now() >= deadline) {
      let diagnosticSuffix = "";
      if (onTimeout) {
        try {
          diagnosticSuffix = `; diagnostics=${JSON.stringify(await onTimeout())}`;
        } catch (error) {
          diagnosticSuffix = `; diagnosticsError=${error instanceof Error ? error.message : String(error)}`;
        }
      }
      throw new Error(
        `Scheduled Bot verification expected ${expected}, received ${value}${diagnosticSuffix}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
try {
  const workspaceRoot = join(root, "workspaces");
  await mkdir(join(workspaceRoot, "repo"), { recursive: true });
  const provider = fauxProvider({
    provider: "native-schedule",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const config = {
    dataRoot: join(root, "data"),
    workspaceRoot,
    adminToken: "native-schedule-fixture",
    shutdownGraceMs: 0,
    maxConcurrent: 1,
    runtime: { defaultThinkingLevel: "off" },
  };
  bot = await createBotApplication(config, { models });
  const workspace = [...bot.workspaceProjects.keys()][0];
  const thread = await bot.core.createThread(workspace);
  await bot.core.renameThread(thread.id, "Native schedule");
  // Planning includes native worker startup; keep automatic delivery disarmed until it settles.
  const at = Date.now() + 86400_000;
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: `text(await tools.schedule(${JSON.stringify({
          action: "create",
          name: "Native proof",
          prompt: "Write the scheduled verification file",
          rule: { type: "interval", everyMs: 300000, anchorAt: at },
        })}));`,
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Plan created"),
  ]);
  await bot.controller.submit(thread.id, "Plan a native scheduled task", "ordinary-request");
  await poll(async () => (await bot.core.listSchedules({ threadId: thread.id })).length, 1);
  await poll(() => bot.controller.status().activeThreads.length, 0);
  assert.deepEqual(await bot.core.listScheduleProposals(), []);
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'await tools.write({path:"scheduled.txt",content:"Native scheduled work"});',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Finished native work"),
  ]);
  const schedule = (await bot.core.listSchedules())[0];
  assert.equal(schedule.state, "active");
  const armed = await bot.core.updateSchedule({
    scheduleId: schedule.id,
    expectedRevision: schedule.revision,
    requestId: "arm-native-delivery",
    patch: { rule: { type: "interval", everyMs: 300000, anchorAt: Date.now() + 5000 } },
  });
  assert.equal(armed.state, "applied");
  await poll(
    async () => (await bot.core.listScheduleRuns({ scheduleId: schedule.id }))[0]?.state,
    "succeeded",
    {
      onTimeout: async () => {
        const schedules = await bot.core.listSchedules({ threadId: thread.id });
        const currentSchedule = schedules.find((entry) => entry.id === schedule.id);
        const runs = await bot.core.listScheduleRuns({ scheduleId: schedule.id });
        const state = await bot.core.scheduleSnapshot();
        const pendingRequests = state.requests
          .filter((request) => request.threadId === thread.id)
          .map((request) => ({ action: request.change?.action, createdAt: request.createdAt }));
        const lifecycleIntents = state.lifecycleIntents
          .filter((intent) => intent.threadId === thread.id)
          .map((intent) => ({ action: intent.action, createdAt: intent.createdAt }));
        // Whitelist state and timing metadata; do not emit the schedule prompt or transcript.
        return {
          observedAt: new Date().toISOString(),
          pendingManagement: {
            requests: pendingRequests,
            lifecycleIntents,
          },
          schedule: currentSchedule
            ? {
                id: currentSchedule.id,
                state: currentSchedule.state,
                revision: currentSchedule.revision,
                rule: currentSchedule.rule,
                nextRunAt: currentSchedule.nextRunAt,
                consumedThrough: currentSchedule.consumedThrough,
                blockedReason: currentSchedule.blockedReason,
                updatedAt: currentSchedule.updatedAt,
              }
            : null,
          occurrenceCount: runs.length,
          recentOccurrences: runs.slice(0, 3).map((run) => ({
            id: run.id,
            scheduleRevision: run.scheduleRevision,
            scheduledAt: run.scheduledAt,
            source: run.source,
            detectedAt: run.detectedAt,
            admittedAt: run.admittedAt,
            operationId: run.operationId,
            inputEntryId: run.inputEntryId,
            finishedAt: run.finishedAt,
            state: run.state,
            reason: run.reason,
          })),
          activeThreads: bot.controller.status().activeThreads,
        };
      },
    },
  );
  assert.equal(
    await readFile(join(workspaceRoot, "repo", "scheduled.txt"), "utf8"),
    "Native scheduled work",
  );
  const opened = await bot.core.openThread(thread.id);
  assert.equal(opened.snapshot.configuration.agentMode, "codemode");
  const messages = opened.snapshot.transcript.filter((entry) => entry.message.role === "user");
  assert.equal(messages.length, 2);
  const occurrence = (await bot.core.listScheduleRuns({ scheduleId: schedule.id }))[0];
  assert.equal(occurrence.source, "automatic");
  assert.equal(occurrence.inputEntryId, messages[1].id);
  assert.equal(provider.state.callCount, 4);
  await bot.core.archiveThread(thread.id, true);
  await bot.core.archiveThread(thread.id, false);
  assert.equal((await bot.core.listSchedules())[0].state, "paused");
  await bot.close();
  bot = await createBotApplication(config, { models });
  assert.equal((await bot.core.listSchedules())[0].state, "paused");
  assert.equal(
    (await bot.core.listScheduleRuns({ scheduleId: schedule.id }))[0].state,
    "succeeded",
  );
  console.log(
    "Native scheduled Bot verified: root tool, direct creation, automatic Controller delivery, real sandbox write, stable source receipt and restart.",
  );
} finally {
  await bot?.close();
  await rm(root, { recursive: true, force: true });
}
