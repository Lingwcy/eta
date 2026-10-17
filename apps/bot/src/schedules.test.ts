import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Schema } from "effect";
import { defineTool } from "@eta/agent";
import { createCore } from "@eta/core";
import type { CoreEnvironment } from "@eta/core";
import { ScheduleStoreSchema } from "@eta/core/shared/schedules";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createBotApplication, type BotApplication } from "./application.ts";
import { BotController } from "./controller.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  maximum = 1,
  environment: Partial<CoreEnvironment> = {},
  agentMode: "standard" | "codemode" = "standard",
) {
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
    runtime: { agentMode, defaultThinkingLevel: "off" as const },
  };
  const open = async () => {
    const bot = await createBotApplication(config, { models, environment });
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
    config,
    models,
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
      // #51: approval latency can outlast a near-future slot, so create far out and arm later.
      rule: { type: "once", at: now + 60_000 },
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

/** Arm a near-future slot after approval so setup latency cannot decide whether it is ever due. */
async function armScheduleSoon(bot: BotApplication, threadId: string, scheduleId: string) {
  const [schedule] = await bot.core.listSchedules({ threadId });
  if (!schedule) throw new Error("Approved schedule is missing");
  await bot.core.updateSchedule({
    scheduleId,
    expectedRevision: schedule.revision,
    requestId: "arm",
    patch: { rule: { type: "once", at: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 500 } },
  });
}

/** One value for capacity polls, so failure output includes the occurrence, next slot, and Controller state. */
async function scheduledRunState(bot: BotApplication, threadId: string, scheduleId: string) {
  const [run] = await bot.core.listScheduleRuns({ scheduleId });
  return {
    reason: run?.reason,
    state: run?.state,
    nextRunAt: (await bot.core.listSchedules({ threadId }))[0]?.nextRunAt,
    activeThreads: bot.controller.status().activeThreads,
  };
}

test.each([
  { source: "automatic", mode: "standard", cleanup: "normal" },
  { source: "manual", mode: "standard", cleanup: "normal" },
  { source: "ordinary", mode: "standard", cleanup: "normal" },
  { source: "automatic", mode: "codemode", cleanup: "normal" },
  { source: "automatic", mode: "standard", cleanup: "fails" },
] as const)(
  "restart recovers $source work after a child report starts a $mode follow-up ($cleanup cleanup)",
  async ({ source, mode, cleanup }) => {
    const releaseChild = Promise.withResolvers<void>();
    const releaseTool = Promise.withResolvers<void>();
    let executions = 0;
    const tool = defineTool({
      name: "wait_for_deployment",
      description: "An unsafe invocation interrupted by the deployment it waits for",
      parameters: Type.Object({}),
      replay: "unsafe",
      execute: async (_input, _api, context) => {
        executions++;
        const abort = () => releaseTool.resolve();
        context.abortSignal?.addEventListener("abort", abort, { once: true });
        try {
          if (!context.abortSignal?.aborted) await releaseTool.promise;
        } finally {
          context.abortSignal?.removeEventListener("abort", abort);
        }
        return {};
      },
    });
    const environment: Partial<CoreEnvironment> = {
      extensions: () => [{ name: "deployment-wait", tools: [tool] }],
    };
    const { bot, open, thread, fast, releaseModel, config, models } = await fixture(
      1,
      environment,
      mode,
    );
    releaseModel();
    let rootRequests = 0;
    const responses: Parameters<typeof fast.setResponses>[0] = Array.from(
      { length: 12 },
      () => async (context) => {
        if (
          context.messages.some(
            (message) => message.role === "user" && message.content === "Delayed delegated work",
          )
        ) {
          await releaseChild.promise;
          return fauxAssistantMessage("Completed delegated work");
        }
        rootRequests++;
        if (rootRequests === 1) {
          const args = {
            action: "spawn",
            name: "worker",
            message: "Delayed delegated work",
            wait: false,
          };
          return fauxAssistantMessage(
            mode === "codemode"
              ? fauxToolCall("codemode", { code: `await tools.subagent(${JSON.stringify(args)});` })
              : fauxToolCall("subagent", args),
            { stopReason: "toolUse" },
          );
        }
        if (rootRequests === 2) return fauxAssistantMessage("Waiting for delegated results");
        return fauxAssistantMessage(
          mode === "codemode"
            ? fauxToolCall("codemode", { code: "await tools.wait_for_deployment({});" })
            : fauxToolCall(tool.name, {}),
          { stopReason: "toolUse" },
        );
      },
    );
    fast.setResponses(responses);
    try {
      const id = await thread("Release reviewer");
      const peer = await thread("Queued scheduled work");
      const created = await bot.core.createSchedule({
        threadId: id,
        requestId: "review-plan",
        name: "Recurring review",
        prompt: "Review and delegate",
        rule: { type: "interval", everyMs: 3600_000, anchorAt: Date.now() + 86400_000 },
      });
      const scheduleId = created.scheduleId!;
      let original: string;
      if (source === "ordinary") {
        fast.setResponses([fauxAssistantMessage("Historical schedule completed")]);
        await bot.core.runScheduleNow({
          scheduleId,
          expectedRevision: 1,
          requestId: "historical-run",
        });
        await expect
          .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.state, {
            timeout: 10000,
          })
          .toBe("succeeded");
        await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
        fast.setResponses(responses);
        original = (await bot.controller.submit(id, "Ordinary delegated work", "ordinary"))
          .operationId;
      } else {
        if (source === "manual") {
          await bot.core.runScheduleNow({
            scheduleId,
            expectedRevision: 1,
            requestId: "run-review",
          });
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
          try {
            await bot.core.updateSchedule({
              scheduleId,
              expectedRevision: 1,
              requestId: "arm-review",
              patch: { rule: { type: "interval", everyMs: 3600_000, anchorAt: Date.now() + 500 } },
            });
          } finally {
            clock.mockRestore();
          }
        }
        await expect
          .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.operationId, {
            timeout: 10000,
          })
          .toBeTruthy();
        original = (await bot.core.listScheduleRuns({ scheduleId }))[0].operationId!;
      }
      await expect
        .poll(async () => (await bot.core.operation(id, original)).status, { timeout: 10000 })
        .toBe("completed");
      const queued = await bot.core.createSchedule({
        threadId: peer,
        requestId: "peer-plan",
        name: "Peer",
        prompt: "Run queued work",
        rule: { type: "once", at: Date.now() + 86400_000 },
      });
      await bot.core.runScheduleNow({
        scheduleId: queued.scheduleId!,
        expectedRevision: 1,
        requestId: "peer-run",
      });
      await expect
        .poll(() => scheduledRunState(bot, peer, queued.scheduleId!))
        .toMatchObject({ reason: "busy" });
      if (source !== "ordinary") {
        await expect
          .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.state)
          .toBe("succeeded");
      }
      releaseChild.resolve();
      await expect.poll(() => executions, { timeout: 10000 }).toBe(1);
      const followup = (await bot.core.openThread(id)).snapshot.operation!.id;
      expect(followup).not.toBe(original);
      await bot.close();
      fast.setResponses([fauxAssistantMessage("Queued work completed")]);
      if (cleanup === "fails") {
        const core = await createCore({
          dataRoot: config.dataRoot,
          home: join(config.dataRoot, "home"),
          models,
          settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
          environment,
        });
        cleanups.push(() => core.close());
        const controller = new BotController(core, bot.workspaceProjects, 1);
        cleanups.push(() => controller.close(0));
        const stop = vi
          .spyOn(core, "stop")
          .mockRejectedValueOnce(new Error("Follow-up cleanup failed"));
        try {
          await controller.recover();
          expect(controller.status().blocked[id]).toBe("Follow-up cleanup failed");
          expect((await core.operation(id, followup)).status).toBe("paused");
          expect((await core.listScheduleRuns({ scheduleId }))[0].state).toBe("succeeded");
          await expect(controller.submit(peer, "Other work", "blocked-peer")).rejects.toMatchObject(
            { code: "Busy" },
          );
        } finally {
          stop.mockRestore();
        }
        await controller.stop(id);
        const resumed = await controller.submit(peer, "Other work", "after-cleanup");
        await expect
          .poll(async () => (await core.operation(peer, resumed.operationId)).status)
          .toBe("completed");
        expect(executions).toBe(1);
        return;
      }
      const restored = await open();
      if (source === "ordinary") {
        expect(restored.controller.status().blocked[id]).toContain("maintainer review");
        expect((await restored.core.operation(id, followup)).status).toBe("paused");
        await restored.controller.stop(id);
      } else {
        await expect
          .poll(async () => (await restored.core.operation(id, followup)).status)
          .toBe("aborted");
        expect((await restored.core.listScheduleRuns({ scheduleId }))[0].state).toBe("succeeded");
        expect(restored.controller.status().blocked[id]).toBeUndefined();
      }
      expect((await restored.core.operation(id, original)).status).toBe("completed");
      expect((await restored.core.listSchedules({ threadId: id }))[0].state).toBe("active");
      expect(executions).toBe(1);
      await expect
        .poll(() => scheduledRunState(restored, peer, queued.scheduleId!), { timeout: 10000 })
        .toMatchObject({ state: "succeeded" });
    } finally {
      releaseChild.resolve();
      releaseTool.resolve();
    }
  },
  30000,
);

test.each([
  { source: "scheduled", cleanup: "normal" },
  { source: "ordinary", cleanup: "normal" },
  { source: "scheduled", cleanup: "fails" },
  { source: "scheduled", cleanup: "restart" },
  { source: "scheduled", cleanup: "superseded" },
] as const)(
  "$source quota failure releases queued reports and retries after quota resets ($cleanup cleanup)",
  async ({ source, cleanup }) => {
    const setup = await fixture();
    const { thread, fast, releaseModel, open } = setup;
    let bot = setup.bot;
    releaseModel();
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const finishCleanup = Promise.withResolvers<void>();
    const replacementEntered = Promise.withResolvers<void>();
    const finishReplacement = Promise.withResolvers<void>();
    const exhausted = () =>
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Codex error: The usage limit has been reached",
      });
    fast.setResponses([
      async () => {
        requested.resolve();
        await release.promise;
        return exhausted();
      },
      fauxAssistantMessage("First retained report"),
      fauxAssistantMessage("Second retained report"),
      exhausted(),
    ]);
    try {
      const id = await thread("Quota-limited reviewer");
      const peer = await thread("Another scheduled task");
      const plan = await bot.core.createSchedule({
        threadId: id,
        requestId: "recurring",
        name: "Hourly review",
        prompt: "Review again at the next slot",
        rule: { type: "interval", everyMs: 3600_000, anchorAt: Date.now() + 86400_000 },
      });
      let operationId: string;
      if (source === "ordinary") {
        operationId = (await bot.controller.submit(id, "Review", "ordinary")).operationId;
      } else {
        await bot.core.runScheduleNow({
          scheduleId: plan.scheduleId!,
          expectedRevision: 1,
          requestId: "first-run",
        });
        await expect
          .poll(
            async () =>
              (await bot.core.listScheduleRuns({ scheduleId: plan.scheduleId! }))[0]?.operationId,
          )
          .toBeTruthy();
        operationId = (await bot.core.listScheduleRuns({ scheduleId: plan.scheduleId! }))[0]
          .operationId!;
      }
      await requested.promise;
      for (const name of ["first", "second"]) {
        await bot.core.subagent(
          id,
          { action: "spawn", name, message: "Return a report", wait: false },
          `child-${name}`,
        );
        await expect
          .poll(
            async () =>
              (await bot.core.openThread(id)).snapshot.subagents?.find(
                (child) => child.path === `/${name}`,
              )?.status,
          )
          .toBe("completed");
      }
      const queued = await bot.core.createSchedule({
        threadId: peer,
        requestId: "peer",
        name: "Peer review",
        prompt: "Other scheduled work",
        rule: { type: "once", at: Date.now() + 86400_000 },
      });
      await bot.core.runScheduleNow({
        scheduleId: queued.scheduleId!,
        expectedRevision: 1,
        requestId: "run-peer",
      });
      await expect
        .poll(() => scheduledRunState(bot, peer, queued.scheduleId!))
        .toMatchObject({ reason: "busy" });
      let failedSnapshots = 0;
      const openThread = bot.core.openThread.bind(bot.core);
      const inspection =
        cleanup === "superseded"
          ? vi.spyOn(bot.core, "openThread").mockImplementation(async (threadId) => {
              const view = await openThread(threadId);
              if (
                threadId === id &&
                !view.snapshot.operation &&
                view.snapshot.lastResult?.status === "failed" &&
                ++failedSnapshots === 2
              ) {
                cleanupEntered.resolve();
                await finishCleanup.promise;
              }
              return view;
            })
          : undefined;
      const stop =
        cleanup === "fails" || cleanup === "restart"
          ? vi.spyOn(bot.core, "stop").mockRejectedValue(new Error("Quota cleanup failed"))
          : undefined;
      try {
        release.resolve();
        await expect
          .poll(async () => (await bot.core.operation(id, operationId)).status)
          .toBe("failed");
        if (stop) {
          await expect.poll(() => bot.controller.status().blocked[id]).toBe("Quota cleanup failed");
          expect(await scheduledRunState(bot, peer, queued.scheduleId!)).toMatchObject({
            reason: "busy",
            activeThreads: [id],
          });
          if (cleanup === "restart") await bot.close();
        }
        if (inspection) {
          // Hold cleanup's authorization after it read the old failure, then replace the admission.
          await cleanupEntered.promise;
          await bot.core.stopScheduler();
          await bot.controller.stop(id);
          fast.setResponses([
            async () => {
              replacementEntered.resolve();
              await finishReplacement.promise;
              return fauxAssistantMessage("Replacement complete");
            },
          ]);
          const replacement = await bot.controller.submit(id, "New work", "replacement");
          await replacementEntered.promise;
          finishCleanup.resolve();
          expect((await bot.core.operation(id, replacement.operationId)).status).toBe("running");
          expect(bot.controller.status().activeThreads).toEqual([id]);
          finishReplacement.resolve();
          await expect
            .poll(async () => (await bot.core.operation(id, replacement.operationId)).status)
            .toBe("completed");
          await bot.close();
        }
      } finally {
        stop?.mockRestore();
        inspection?.mockRestore();
        finishCleanup.resolve();
      }
      if (cleanup === "restart" || cleanup === "superseded") {
        fast.setResponses([exhausted(), exhausted(), exhausted()]);
        bot = await open();
      }
      // Queued child wakeups must not reserve the checkout after the model has failed.
      await expect
        .poll(() => scheduledRunState(bot, peer, queued.scheduleId!), { timeout: 5000 })
        .toMatchObject({ state: "failed", activeThreads: [] });
      expect((await bot.core.operation(id, operationId)).error).toContain("usage limit");

      fast.setResponses([exhausted()]);
      await bot.core.runScheduleNow({
        scheduleId: plan.scheduleId!,
        expectedRevision: 1,
        requestId: "still-exhausted",
      });
      await expect
        .poll(
          async () =>
            (await bot.core.listScheduleRuns({ scheduleId: plan.scheduleId! })).find((run) =>
              run.requestId.includes("still-exhausted"),
            )?.state,
        )
        .toBe("failed");
      await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
      expect((await bot.core.listSchedules({ threadId: id }))[0]).toMatchObject({
        state: "active",
      });

      // The reset can happen at any time: the next automatic slot uses the same model and succeeds.
      fast.setResponses([fauxAssistantMessage("Quota reset; scheduled work complete")]);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      try {
        await bot.core.updateSchedule({
          scheduleId: plan.scheduleId!,
          expectedRevision: 1,
          requestId: "arm-after-reset",
          patch: { rule: { type: "interval", everyMs: 3600_000, anchorAt: Date.now() + 500 } },
        });
      } finally {
        clock.mockRestore();
      }
      await expect
        .poll(
          async () =>
            (await bot.core.listScheduleRuns({ scheduleId: plan.scheduleId! })).find(
              (run) => run.source === "automatic",
            )?.state,
          { timeout: 10000 },
        )
        .toBe("succeeded");
      expect((await bot.core.listSchedules({ threadId: id }))[0]).toMatchObject({
        state: "active",
      });
      expect(bot.controller.status().blocked).toEqual({});
      for (const [name, output] of [
        ["first", "First retained report"],
        ["second", "Second retained report"],
      ]) {
        const child = (await bot.core.openThread(id)).snapshot.subagents?.find(
          (agent) => agent.path === `/${name}`,
        );
        expect(child?.output).toContain(output);
      }
    } finally {
      release.resolve();
      finishCleanup.resolve();
      finishReplacement.resolve();
    }
  },
  20000,
);

test.each([
  { source: "automatic", replay: "unsafe", recovery: "normal" },
  { source: "manual", replay: "unsafe", recovery: "normal" },
  { source: "ordinary", replay: "unsafe", recovery: "normal" },
  { source: "automatic", replay: "safe", recovery: "normal" },
  { source: "automatic", replay: "unsafe", recovery: "dispatching" },
  { source: "automatic", replay: "unsafe", recovery: "stop-failed" },
  { source: "automatic", replay: "unsafe", recovery: "nested" },
] as const)(
  "restart handles $source work with a $replay tool ($recovery recovery)",
  async ({ source, replay, recovery }) => {
    let executions = 0;
    const release = Promise.withResolvers<void>();
    const tool = defineTool({
      name: "interrupted_work",
      description: "Controlled work interrupted by a host restart",
      parameters: Type.Object({}),
      replay,
      execute: async (_input, _api, context) => {
        executions++;
        if (executions === 1) {
          const abort = () => release.resolve();
          context.abortSignal?.addEventListener("abort", abort, { once: true });
          try {
            if (!context.abortSignal?.aborted) await release.promise;
          } finally {
            context.abortSignal?.removeEventListener("abort", abort);
          }
        }
        return {};
      },
    });
    const environment: Partial<CoreEnvironment> = {
      extensions: () => [{ name: "interrupted-work", tools: [tool] }],
    };
    const { bot, config, models, open, thread, fast, releaseModel } = await fixture(
      1,
      environment,
      recovery === "nested" ? "codemode" : "standard",
    );
    releaseModel();
    try {
      const id = await thread("Interrupted work");
      const peer = await thread("Another schedule in the same checkout");
      const created = await bot.core.createSchedule({
        threadId: id,
        requestId: "recurring",
        name: "Recurring",
        prompt: "Perform scheduled work",
        rule: { type: "interval", everyMs: 300_000, anchorAt: Date.now() + 86400_000 },
      });
      const scheduleId = created.scheduleId!;
      fast.setResponses([
        fauxAssistantMessage(
          recovery === "nested"
            ? fauxToolCall("codemode", { code: `await tools.${tool.name}({});` })
            : fauxToolCall(tool.name, {}),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Finished work"),
      ]);
      let operationId: string;
      if (source === "ordinary") {
        operationId = (await bot.controller.submit(id, "Ordinary work", "ordinary")).operationId;
      } else {
        if (source === "manual") {
          await bot.core.runScheduleNow({ scheduleId, expectedRevision: 1, requestId: "run" });
        } else {
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
          try {
            await bot.core.updateSchedule({
              scheduleId,
              expectedRevision: 1,
              requestId: "arm-recurring",
              patch: {
                rule: { type: "interval", everyMs: 300_000, anchorAt: Date.now() + 500 },
              },
            });
          } finally {
            clock.mockRestore();
          }
        }
        await expect
          .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.operationId, {
            timeout: 10000,
          })
          .toBeTruthy();
        operationId = (await bot.core.listScheduleRuns({ scheduleId }))[0].operationId!;
      }
      await expect.poll(() => executions, { timeout: 10000 }).toBe(1);
      const queued = await bot.core.createSchedule({
        threadId: peer,
        requestId: "peer",
        name: "Peer",
        prompt: "Other scheduled work",
        rule: { type: "once", at: Date.now() + 86400_000 },
      });
      await bot.core.runScheduleNow({
        scheduleId: queued.scheduleId!,
        expectedRevision: 1,
        requestId: "run-peer",
      });
      await expect
        .poll(() => scheduledRunState(bot, peer, queued.scheduleId!), { timeout: 5000 })
        .toMatchObject({ reason: "busy" });
      await bot.close();
      if (recovery === "dispatching") {
        const path = join(config.dataRoot, "schedules.json");
        const state = Schema.decodeUnknownSync(ScheduleStoreSchema)(
          JSON.parse(await readFile(path, "utf8")),
        );
        await writeFile(
          path,
          JSON.stringify({
            ...state,
            occurrences: Object.fromEntries(
              Object.entries(state.occurrences).map(([key, run]) => [
                key,
                run.operationId === operationId
                  ? { ...run, state: "dispatching", operationId: undefined }
                  : run,
              ]),
            ),
          }),
        );
      }
      fast.setResponses([
        fauxAssistantMessage("Finished after restart"),
        fauxAssistantMessage("Finished queued work"),
      ]);
      if (recovery === "stop-failed") {
        const core = await createCore({
          dataRoot: config.dataRoot,
          home: join(config.dataRoot, "home"),
          models,
          settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
          environment,
        });
        cleanups.push(() => core.close());
        const controller = new BotController(core, bot.workspaceProjects, 1);
        cleanups.push(() => controller.close(0));
        const stop = vi.spyOn(core, "stop").mockRejectedValueOnce(new Error("Stop failed"));
        try {
          await controller.recover();
          expect(controller.status().blocked[id]).toBe("Stop failed");
          expect((await core.operation(id, operationId)).status).toBe("paused");
          expect((await core.listScheduleRuns({ scheduleId }))[0].state).toBe("admitted");
          expect(executions).toBe(1);
          await expect(controller.submit(peer, "New work", "blocked-peer")).rejects.toMatchObject({
            code: "Busy",
          });
        } finally {
          stop.mockRestore();
        }
        await controller.stop(id);
        const admitted = await controller.submit(peer, "New work", "after-stop");
        await expect
          .poll(async () => (await core.operation(peer, admitted.operationId)).status, {
            timeout: 10000,
          })
          .toBe("completed");
        return;
      }
      const restored = await open();
      if (source === "ordinary") {
        expect(restored.controller.status().blocked[id]).toContain("maintainer review");
        expect(await restored.core.recovery(id)).toMatchObject({
          required: true,
          unsafeTool: true,
        });
        expect(executions).toBe(1);
        await restored.controller.stop(id);
      } else {
        await expect
          .poll(async () => (await restored.core.operation(id, operationId)).status, {
            timeout: 10000,
          })
          .toBe(replay === "unsafe" ? "aborted" : "completed");
        await expect
          .poll(async () => (await restored.core.listScheduleRuns({ scheduleId }))[0]?.state, {
            timeout: 10000,
          })
          .toBe(replay === "unsafe" ? "cancelled" : "succeeded");
        expect((await restored.core.listSchedules({ threadId: id }))[0].state).toBe("active");
        expect(executions).toBe(replay === "unsafe" ? 1 : 2);
        expect(restored.controller.status().blocked[id]).toBeUndefined();
      }
      await expect
        .poll(() => scheduledRunState(restored, peer, queued.scheduleId!), { timeout: 10000 })
        .toMatchObject({ state: "succeeded" });
    } finally {
      release.resolve();
    }
  },
  45000,
);

test("automatic scheduling respects same-project exclusion and wakes when Controller releases capacity", async () => {
  const { bot, thread, releaseModel } = await fixture(4);
  const ordinary = await thread("Ordinary work");
  const scheduled = await thread("Scheduled work");
  await bot.controller.submit(ordinary, "Keep running ordinary work", "ordinary");
  const scheduleId = await approvedSchedule(bot, scheduled);
  await armScheduleSoon(bot, scheduled, scheduleId);
  await expect
    .poll(() => scheduledRunState(bot, scheduled, scheduleId), { timeout: 5000 })
    .toMatchObject({ reason: "busy" });
  expect(
    (await bot.core.openThread(scheduled)).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ),
  ).toHaveLength(0);
  expect(bot.controller.status().activeThreads).toContain(ordinary);
  releaseModel();
  await bot.controller.stop(ordinary);
  await expect
    .poll(() => scheduledRunState(bot, scheduled, scheduleId), { timeout: 5000 })
    .toMatchObject({ state: "succeeded" });
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
  await armScheduleSoon(bot, scheduled, scheduleId);
  await expect
    .poll(() => scheduledRunState(bot, scheduled, scheduleId), { timeout: 5000 })
    .toMatchObject({ reason: "busy" });
  expect(bot.controller.status().activeThreads).toEqual([ordinary]);
  releaseModel();
  await bot.controller.stop(ordinary);
  await expect
    .poll(() => scheduledRunState(bot, scheduled, scheduleId), { timeout: 5000 })
    .toMatchObject({ state: "succeeded" });
}, 15000);

test("Core scheduling boundaries reject workspaces outside Bot scope before persisting plans or proposals", async () => {
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
  await expect(
    bot.core.changeSchedule({
      threadId: thread.id,
      requestId: "outside-write",
      change: input.change,
    }),
  ).rejects.toMatchObject({ code: "WorkspaceUnavailable" });
  expect(await bot.core.listScheduleProposals({ threadId: thread.id })).toEqual([]);
  expect(await bot.core.listSchedules({ threadId: thread.id })).toEqual([]);
});

test.each(["immediate", "delayed"])(
  "Bot root tool creates an active plan before automatic Controller delivery (%s arming)",
  async (arming) => {
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
            rule: { type: "interval", everyMs: 300_000, anchorAt: Date.now() + 86400_000 },
          },
          { id: "plan" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Plan created"),
    ]);
    await bot.controller.submit(id, "Plan a review", "ordinary");
    await expect
      .poll(async () => (await bot.core.listSchedules({ threadId: id })).length, {
        timeout: 5000,
      })
      .toBe(1);
    await expect.poll(() => bot.controller.status().activeThreads.length).toBe(0);
    expect(await bot.core.listScheduleProposals({ threadId: id })).toEqual([]);
    fast.setResponses([fauxAssistantMessage("Scheduled review finished")]);
    const schedule = (await bot.core.listSchedules({ threadId: id }))[0];
    expect(schedule.state).toBe("active");
    const realNow = Date.now.bind(Date);
    const now = realNow();
    const anchorAt = now + 1500;
    // Persist the chosen slot before the scheduler's clock can pass it under host load.
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      if (arming === "delayed")
        await expect.poll(realNow, { timeout: 5000 }).toBeGreaterThan(anchorAt);
      expect(
        await bot.core.updateSchedule({
          scheduleId: schedule.id,
          expectedRevision: schedule.revision,
          requestId: "arm-tool-schedule",
          patch: { rule: { type: "interval", everyMs: 300_000, anchorAt } },
        }),
      ).toMatchObject({ state: "applied" });
      expect((await bot.core.listSchedules({ threadId: id }))[0]?.nextRunAt).toBe(anchorAt);
    } finally {
      clock.mockRestore();
    }
    await expect
      .poll(() => scheduledRunState(bot, id, schedule.id), {
        timeout: 8000,
      })
      .toMatchObject({ state: "succeeded" });
    const messages = (await bot.core.openThread(id)).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    );
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[1])).toContain("Scheduled review");
  },
  15000,
);
