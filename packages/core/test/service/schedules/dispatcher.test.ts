import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { CatalogService } from "@eta/core/service/catalog/index";
import { ScheduleStoreService } from "@eta/core/service/schedules/store";
import { ScheduleGateService } from "@eta/core/service/schedules/gate";
import {
  ScheduleDispatcherService,
  type ScheduleHostAdapter,
  type ScheduleAdmissionResult,
} from "@eta/core/service/schedules/dispatcher";
import { scheduleHostAdapter } from "@eta/core/service/schedules/host";
import { scheduleDraft, writeScheduleChange } from "@eta/core/service/schedules/management";
import { ThreadService } from "@eta/core/service/threads/index";
import { ProjectService } from "@eta/core/service/projects/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import type { OperationResult } from "@eta/core/agent/protocol";
import { testServices } from "../../support/runtime.ts";
import { catalogFixture } from "../catalog/test-fixtures.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-dispatcher-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = ManagedRuntime.make(
    ScheduleDispatcherService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ScheduleStoreService.layer.pipe(Layer.provide(AppPathsService.layer(root))),
          ScheduleGateService.layer,
          Layer.succeed(CatalogService, {
            read: Effect.succeed(catalogFixture()),
            update: () => Effect.succeed(catalogFixture()),
            subscribe: () => () => {},
          }),
        ),
      ),
    ),
  );
  cleanups.push(() => runtime.dispose());
  const store = await runtime.runPromise(ScheduleStoreService);
  const dispatcher = await runtime.runPromise(ScheduleDispatcherService);
  await runtime.runPromise(
    store.update((state) => {
      const draft = scheduleDraft(state);
      writeScheduleChange(
        draft,
        {
          threadId: "thread",
          requestId: "create",
          change: {
            action: "create",
            name: "Review",
            prompt: "Saved prompt",
            rule: { type: "once", at: 100 },
          },
        },
        catalogFixture(),
        0,
      );
      return draft;
    }),
  );
  const operations = new Map<string, OperationResult>();
  const calls: Array<{ threadId: string; prompt: string; requestId: string }> = [];
  const host: ScheduleHostAdapter = {
    validate: async () => undefined,
    submit: async (input) => {
      calls.push(input);
      const operation: OperationResult = {
        operationId: "op",
        kind: "run",
        startedAt: 100,
        status: "running",
        messages: [],
      };
      operations.set(input.requestId, operation);
      return { status: "admitted", admission: operation };
    },
    lookup: async ({ requestId }) =>
      operations.has(requestId)
        ? { status: "admitted", operation: operations.get(requestId)! }
        : { status: "absent", settled: true },
  };
  return { runtime, store, dispatcher, calls, host, operations };
}

test("delivers saved prompt and persists actual operation success, not merely submission success", async () => {
  const { runtime, store, dispatcher, calls, host, operations } = await fixture();
  await runtime.runPromise(dispatcher.tick(host, 100));
  let state = await runtime.runPromise(store.read);
  const occurrence = Object.values(state.occurrences)[0];
  expect(calls).toHaveLength(1);
  expect(calls[0].prompt).toBe("Saved prompt");
  expect(occurrence.state).toBe("admitted");
  await runtime.runPromise(dispatcher.tick(host, 200));
  expect(calls).toHaveLength(1);
  operations.set(occurrence.requestId, {
    ...operations.get(occurrence.requestId)!,
    status: "completed",
    endedAt: 300,
  });
  await runtime.runPromise(dispatcher.tick(host, 400));
  state = await runtime.runPromise(store.read);
  expect(state.occurrences[occurrence.id].state).toBe("succeeded");
  expect(Object.values(state.schedules)[0].state).toBe("completed");
  await runtime.runPromise(dispatcher.tick(host, 100));
  expect(calls).toHaveLength(1);
});

test("restores dispatching from the host receipt without a second submission", async () => {
  const { runtime, store, dispatcher, host, calls } = await fixture();
  await runtime.runPromise(dispatcher.tick(host, 100));
  await runtime.runPromise(
    store.update((state) => {
      const draft = scheduleDraft(state);
      const occurrence = Object.values(draft.occurrences)[0];
      const { operationId: _operationId, admittedAt: _admittedAt, ...frozen } = occurrence;
      draft.occurrences[occurrence.id] = { ...frozen, state: "dispatching" };
      return draft;
    }),
  );
  await runtime.runPromise(dispatcher.tick(host, 200));
  expect(calls).toHaveLength(1);
  expect(Object.values((await runtime.runPromise(store.read)).occurrences)[0].state).toBe(
    "admitted",
  );
});

test("unsettled absence never permits blind retry; settled absence retains the same delivery identity", async () => {
  const { runtime, store, dispatcher, host, calls } = await fixture();
  const originalSubmit = host.submit.bind(host);
  host.submit = async (input) => {
    calls.push(input);
    return { status: "unknown", reason: "admissionUnknown" };
  };
  await runtime.runPromise(dispatcher.tick(host, 100));
  host.lookup = async () => ({ status: "absent", settled: false });
  await runtime.runPromise(dispatcher.tick(host, 200));
  expect(calls).toHaveLength(1);
  expect(Object.values((await runtime.runPromise(store.read)).occurrences)[0].state).toBe(
    "dispatching",
  );
  host.lookup = async () => ({ status: "absent", settled: true });
  host.submit = originalSubmit;
  await runtime.runPromise(dispatcher.tick(host, 300));
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
});

test("in-flight admission releases its gate with a durable uncertainty marker and management waits", async () => {
  const { runtime, store, dispatcher, host, calls } = await fixture();
  let release!: (result: ScheduleAdmissionResult) => void;
  const pending = new Promise<ScheduleAdmissionResult>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  host.submit = async (input) => {
    calls.push(input);
    return pending;
  };
  host.lookup = async () => {
    lookups++;
    return { status: "absent", settled: true };
  };
  try {
    await runtime.runPromise(dispatcher.tick(host, 100));
    const state = await runtime.runPromise(store.read);
    const schedule = Object.values(state.schedules)[0];
    expect(Object.values(state.occurrences)[0].state).toBe("dispatching");
    await runtime.runPromise(
      store.update((state) => {
        const draft = scheduleDraft(state);
        writeScheduleChange(
          draft,
          {
            threadId: "thread",
            requestId: "pause",
            change: { action: "pause", scheduleId: schedule.id, expectedRevision: 1 },
          },
          catalogFixture(),
          200,
        );
        return draft;
      }),
    );
    await runtime.runPromise(dispatcher.tick(host, 300));
    expect(lookups).toBe(0);
    expect((await runtime.runPromise(store.read)).requests.pause.state).toBe("pending");
    release({ status: "admitted", admission: { operationId: "op", kind: "run", startedAt: 100 } });
    await pending;
    await runtime.runPromise(dispatcher.tick(host, 400));
    const settled = await runtime.runPromise(store.read);
    expect(settled.requests.pause.state).toBe("applied");
    expect(settled.schedules[schedule.id].state).toBe("paused");
    expect(Object.values(settled.occurrences)[0].state).toBe("admitted");
    expect(calls).toHaveLength(1);
  } finally {
    release({ status: "unknown", reason: "testCleanup" });
  }
});

test("a model failure is terminal and workspace blocking never invokes submit", async () => {
  const { runtime, store, dispatcher, host, calls, operations } = await fixture();
  host.validate = async () => "workspaceUnavailable";
  await runtime.runPromise(dispatcher.tick(host, 100));
  expect(calls).toHaveLength(0);
  expect(Object.values((await runtime.runPromise(store.read)).schedules)[0].blockedReason).toBe(
    "workspaceUnavailable",
  );
  host.validate = async () => undefined;
  await runtime.runPromise(dispatcher.tick(host, 200));
  const occurrence = Object.values((await runtime.runPromise(store.read)).occurrences)[0];
  operations.set(occurrence.requestId, {
    ...operations.get(occurrence.requestId)!,
    status: "failed",
    error: "model failure",
  });
  await runtime.runPromise(dispatcher.tick(host, 300));
  await runtime.runPromise(dispatcher.tick(host, 400));
  expect(calls).toHaveLength(1);
  expect((await runtime.runPromise(store.read)).occurrences[occurrence.id].state).toBe("failed");
});

test("real Core thread receives one ordinary UserMessage from an approved proposal with no subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-schedule-real-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const provider = fauxProvider({
    provider: "schedule-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  provider.setResponses([fauxAssistantMessage("Scheduled work finished")]);
  const models = createModels();
  models.setProvider(provider.provider);
  const runtime = ManagedRuntime.make(testServices(join(root, "data"), models));
  cleanups.push(() => runtime.dispose());
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: root }));
  const workspaces = await runtime.runPromise(WorkspaceService);
  const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0];
  const threads = await runtime.runPromise(ThreadService);
  const thread = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.rename(thread.id, "Scheduled thread"));
  const { ScheduleService } = await import("@eta/core/service/schedules/index");
  const schedules = await runtime.runPromise(ScheduleService);
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  const proposed = await runtime.runPromise(
    schedules.propose({
      threadId: thread.id,
      requestId: "tool",
      sourceIdentity: "root:tool",
      change: {
        action: "create",
        name: "Review",
        prompt: "Review repository",
        rule: { type: "once", at: now + 100_000 },
      },
    }),
  );
  expect(await runtime.runPromise(schedules.list())).toEqual([]);
  const proposal = (await runtime.runPromise(schedules.proposals()))[0];
  expect(proposal.id).toBe(proposed.proposalId);
  await runtime.runPromise(
    schedules.decide(
      {
        proposalId: proposal.id,
        contentFingerprint: proposal.contentFingerprint,
        requestId: "approve",
      },
      true,
    ),
  );
  const dispatcher = await runtime.runPromise(ScheduleDispatcherService);
  const admissionGate = Promise.withResolvers<void>();
  let submitPhase = "not started";
  const adapter = scheduleHostAdapter(
    {
      submit: async (id, prompt, requestId) => {
        submitPhase = "waiting for the test to release admission";
        await admissionGate.promise;
        submitPhase = "calling Core submit";
        try {
          const result = await runtime.runPromise(threads.submit(id, prompt, requestId));
          submitPhase = `Core submit returned ${result.operationId}`;
          return result;
        } catch (error) {
          submitPhase = `Core submit failed: ${String(error)}`;
          throw error;
        }
      },
      operationByRequest: (id, requestId) =>
        runtime.runPromise(threads.operationByRequest(id, requestId)),
      recovery: (id) => runtime.runPromise(threads.recovery(id)),
    },
    async (id) => {
      const thread = await runtime.runPromise(threads.get(id));
      await runtime.runPromise(workspaces.validate(thread.workspaceId));
      return undefined;
    },
  );
  await runtime.runPromise(dispatcher.tick(adapter, now + 100_000));
  const schedule = (await runtime.runPromise(schedules.list()))[0];
  const occurrence = (await runtime.runPromise(schedules.runs(schedule.id)))[0];
  expect(occurrence.state).toBe("dispatching");
  expect(submitPhase).toBe("waiting for the test to release admission");
  admissionGate.resolve();
  let lastObservation = "no dispatcher poll yet";
  await expect
    .poll(
      async () => {
        await runtime.runPromise(dispatcher.tick(adapter, now + 100_000));
        const current = (await runtime.runPromise(schedules.runs(schedule.id))).find(
          (run) => run.id === occurrence.id,
        );
        lastObservation = `${current?.state ?? "missing"}; reason=${current?.reason ?? "none"}; operation=${current?.operationId ?? "none"}`;
        return current?.state;
      },
      { timeout: 45_000 },
    )
    .toBe("succeeded")
    .catch(async (error: unknown) => {
      const receipt = await runtime
        .runPromise(threads.operationByRequest(thread.id, occurrence.requestId))
        .catch((failure: unknown) => ({ failure: String(failure) }));
      console.error("Scheduled admission diagnostic", { submitPhase, lastObservation, receipt });
      throw error;
    });
  await runtime.runPromise(dispatcher.tick(adapter, now + 100_001));
  expect((await runtime.runPromise(schedules.runs(schedule.id)))[0].state).toBe("succeeded");
  await runtime.runPromise(dispatcher.tick(adapter, now + 100_002));
  const opened = await runtime.runPromise(threads.open(thread.id));
  const userMessages = opened.snapshot.transcript.filter((entry) => entry.message.role === "user");
  expect(userMessages).toHaveLength(1);
  expect(JSON.stringify(userMessages[0])).toContain("Review repository");
  provider.setResponses([fauxAssistantMessage("Manual work finished")]);
  await runtime.runPromise(
    schedules.runNow({
      threadId: thread.id,
      scheduleId: schedule.id,
      expectedRevision: schedule.revision,
      requestId: "manual",
    }),
  );
  await runtime.runPromise(dispatcher.tick(adapter, now + 100_003));
  const manual = (await runtime.runPromise(schedules.runs(schedule.id))).find(
    (run) => run.source === "manual",
  )!;
  await expect
    .poll(
      async () => {
        const before = (await runtime.runPromise(schedules.runs(schedule.id))).find(
          (run) => run.id === manual.id,
        );
        if (!before?.operationId) await runtime.runPromise(dispatcher.tick(adapter, now + 100_003));
        const current = (await runtime.runPromise(schedules.runs(schedule.id))).find(
          (run) => run.id === manual.id,
        );
        if (!current?.operationId) return undefined;
        return (await runtime.runPromise(threads.operation(thread.id, current.operationId))).status;
      },
      { timeout: 10000 },
    )
    .toBe("completed");
  expect(
    (await runtime.runPromise(schedules.runs(schedule.id))).find((run) => run.id === manual.id)
      ?.state,
  ).toBe("admitted");
  await runtime.runPromise(threads.remove(thread.id));
  expect(
    (await runtime.runPromise(schedules.runs(schedule.id))).find((run) => run.id === manual.id)
      ?.state,
  ).toBe("succeeded");
  expect(await runtime.runPromise(schedules.list())).toEqual([]);
}, 60_000);

test("dispatcher remains dormant until host readiness, rejects a second start and stops new triggers", async () => {
  const { runtime, store, dispatcher, host, calls } = await fixture();
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  await runtime.runPromise(
    store.update((state) => {
      const draft = scheduleDraft(state);
      const schedule = Object.values(draft.schedules)[0];
      writeScheduleChange(
        draft,
        {
          threadId: "thread",
          requestId: "future",
          change: {
            action: "update",
            scheduleId: schedule.id,
            expectedRevision: 1,
            patch: { rule: { type: "once", at: now + 100 } },
          },
        },
        catalogFixture(),
        now,
      );
      return draft;
    }),
  );
  expect(calls).toHaveLength(0);
  await runtime.runPromise(dispatcher.start(host));
  expect((await runtime.runPromise(Effect.flip(dispatcher.start(host)))).code).toBe("Busy");
  await expect.poll(() => calls.length, { timeout: 5000 }).toBe(1);
  await runtime.runPromise(dispatcher.stop);
  await runtime.runPromise(dispatcher.stop);
  await runtime.runPromise(
    store.update((state) => {
      const draft = scheduleDraft(state);
      writeScheduleChange(
        draft,
        {
          threadId: "thread",
          requestId: "later",
          change: {
            action: "create",
            name: "Later",
            prompt: "Later",
            rule: { type: "once", at: now + 2000 },
          },
        },
        catalogFixture(),
        now,
      );
      return draft;
    }),
  );
  await runtime.runPromise(dispatcher.tick(host, now + 2000));
  expect(calls).toHaveLength(1);
});

test("busy admission does not wake itself continuously from its own receipt writes", async () => {
  const { runtime, store, dispatcher, host, calls } = await fixture();
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
  await runtime.runPromise(
    store.update((state) => {
      const draft = scheduleDraft(state);
      const schedule = Object.values(draft.schedules)[0];
      writeScheduleChange(
        draft,
        {
          threadId: "thread",
          requestId: "future",
          change: {
            action: "update",
            scheduleId: schedule.id,
            expectedRevision: 1,
            patch: { rule: { type: "once", at: now + 100 } },
          },
        },
        catalogFixture(),
        now,
      );
      return draft;
    }),
  );
  host.submit = async (input) => {
    calls.push(input);
    return { status: "blocked", reason: "busy" };
  };
  await runtime.runPromise(dispatcher.start(host));
  await expect.poll(() => calls.length > 0, { timeout: 5000 }).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  expect(calls).toHaveLength(1);
  expect(Object.values((await runtime.runPromise(store.read)).occurrences)[0].state).toBe(
    "pending",
  );
  await runtime.runPromise(dispatcher.stop);
});
