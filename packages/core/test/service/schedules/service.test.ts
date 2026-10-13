import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { CatalogService } from "@eta/core/service/catalog/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { CoreError } from "@eta/core/service/errors";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { ScheduleStoreService } from "@eta/core/service/schedules/store";
import { ScheduleGateService } from "@eta/core/service/schedules/gate";
import { catalogFixture } from "../catalog/test-fixtures.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-schedule-service-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let currentCatalog = catalogFixture();
  let unavailable = false;
  const workspace = currentCatalog.workspaces[0];
  const runtime = ManagedRuntime.make(
    ScheduleService.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ScheduleStoreService.layer.pipe(Layer.provide(AppPathsService.layer(root))),
          ScheduleGateService.layer,
          Layer.succeed(CatalogService, {
            read: Effect.sync(() => structuredClone(currentCatalog)),
            update: (change) =>
              Effect.sync(() => {
                currentCatalog = change(currentCatalog);
                return currentCatalog;
              }),
            subscribe: () => () => {},
          }),
          Layer.succeed(WorkspaceService, {
            list: () => Effect.succeed([workspace]),
            get: () => Effect.succeed(workspace),
            register: () => Effect.succeed(workspace),
            validate: () =>
              Effect.suspend(() =>
                unavailable
                  ? Effect.fail(new CoreError({ code: "WorkspaceUnavailable", message: "removed" }))
                  : Effect.succeed(workspace),
              ),
          }),
        ),
      ),
    ),
  );
  cleanups.push(() => runtime.dispose());
  const service = await runtime.runPromise(ScheduleService);
  return {
    runtime,
    service,
    unavailable: () => {
      unavailable = true;
    },
    archive: () => {
      currentCatalog = {
        ...currentCatalog,
        threads: currentCatalog.threads.map((thread) => ({ ...thread, archivedAt: 1 })),
      };
    },
  };
}
const create = {
  threadId: "thread",
  requestId: "create",
  change: {
    action: "create" as const,
    name: "Review",
    prompt: "Review repository",
    rule: { type: "interval" as const, everyMs: 300_000, anchorAt: 0 },
  },
};

test("service validates transport inputs and publishes changes after persistent application", async () => {
  const { runtime, service } = await fixture();
  const observed: number[] = [];
  const unsubscribe = service.subscribe(() => {
    observed.push(1);
  });
  const bad = { ...create, extra: "unsupported" };
  expect((await runtime.runPromise(Effect.flip(service.write(bad)))).code).toBe("InvalidInput");
  expect(observed).toHaveLength(0);
  const request = await runtime.runPromise(service.write(create));
  expect(request.state).toBe("applied");
  expect((await runtime.runPromise(service.list("thread")))[0].id).toBe(request.scheduleId);
  expect(await runtime.runPromise(service.request("create"))).toEqual(request);
  expect(observed).toHaveLength(1);
  unsubscribe();
  await runtime.runPromise(service.write(create));
  expect(observed).toHaveLength(1);
});

test("workspace failures block new changes while accepted replay remains queryable after archival", async () => {
  const { runtime, service, unavailable, archive } = await fixture();
  const request = await runtime.runPromise(service.write(create));
  unavailable();
  archive();
  expect(await runtime.runPromise(service.write(create))).toEqual(request);
  expect(
    (await runtime.runPromise(service.write({ ...create, requestId: "archived" }))).state,
  ).toBe("rejected");
  expect(await runtime.runPromise(service.request("create"))).toEqual(request);
  const fresh = await fixture();
  fresh.unavailable();
  expect((await fresh.runtime.runPromise(Effect.flip(fresh.service.write(create)))).code).toBe(
    "WorkspaceUnavailable",
  );
  expect(await fresh.runtime.runPromise(fresh.service.list())).toEqual([]);
});

test("manual run on paused schedules preserves next time and deduplicates its frozen delivery", async () => {
  const { runtime, service } = await fixture();
  const request = await runtime.runPromise(service.write(create));
  const scheduleId = request.scheduleId!;
  await runtime.runPromise(
    service.write({
      threadId: "thread",
      requestId: "pause",
      change: { action: "pause", scheduleId, expectedRevision: 1 },
    }),
  );
  const input = { threadId: "thread", scheduleId, expectedRevision: 2, requestId: "manual" };
  const manual = await runtime.runPromise(service.runNow(input));
  expect(manual.state).toBe("applied");
  expect(await runtime.runPromise(service.runNow(input))).toEqual(manual);
  const runs = await runtime.runPromise(service.runs(scheduleId));
  expect(runs).toHaveLength(1);
  expect(runs[0].source).toBe("manual");
  expect(runs[0].prompt).toBe(create.change.prompt);
  expect((await runtime.runPromise(service.list()))[0].nextRunAt).toBeNull();
  expect((await runtime.runPromise(service.runNow({ ...input, requestId: "other" }))).state).toBe(
    "rejected",
  );
});

test("service proposals and decisions persist without implicitly executing a thread", async () => {
  const { runtime, service } = await fixture();
  const proposed = await runtime.runPromise(
    service.propose({ ...create, sourceIdentity: "session:root:tool" }),
  );
  expect(await runtime.runPromise(service.list())).toEqual([]);
  const proposal = (await runtime.runPromise(service.proposals()))[0];
  expect(proposal.id).toBe(proposed.proposalId);
  const result = await runtime.runPromise(
    service.decide(
      {
        proposalId: proposal.id,
        contentFingerprint: proposal.contentFingerprint,
        requestId: "approve",
      },
      true,
    ),
  );
  expect(result.state).toBe("applied");
  expect((await runtime.runPromise(service.proposals()))[0].state).toBe("approved");
  expect(await runtime.runPromise(service.runs(result.scheduleId!))).toEqual([]);
});

test("thread gates serialize admission boundaries while unrelated threads progress", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* ScheduleGateService;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: string[] = [];
      const first = yield* Effect.forkChild(
        gate.withThread(
          "one",
          Effect.gen(function* () {
            order.push("first");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            order.push("released");
          }),
        ),
      );
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(
        gate.withThread(
          "one",
          Effect.sync(() => order.push("second")),
        ),
      );
      yield* gate.withThread(
        "two",
        Effect.sync(() => order.push("other")),
      );
      expect(order).toEqual(["first", "other"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["first", "other", "released", "second"]);
    }).pipe(Effect.provide(ScheduleGateService.layer)),
  );
});

test("decision replay resolves its receipt even after terminal proposal history has been pruned", async () => {
  const { runtime, service } = await fixture();
  const proposed = await runtime.runPromise(
    service.propose({ ...create, sourceIdentity: "root:call" }),
  );
  const proposal = (await runtime.runPromise(service.proposals()))[0];
  const input = {
    proposalId: proposal.id,
    contentFingerprint: proposal.contentFingerprint,
    requestId: "reject",
  };
  const rejected = await runtime.runPromise(service.decide(input, false));
  const store = await runtime.runPromise(ScheduleStoreService);
  await runtime.runPromise(
    store.update((state) => {
      const proposals = { ...state.proposals };
      delete proposals[proposed.proposalId!];
      return { ...state, proposals };
    }),
  );
  expect(await runtime.runPromise(service.proposals())).toEqual([]);
  expect(await runtime.runPromise(service.decide(input, false))).toEqual(rejected);
  expect(
    (
      await runtime.runPromise(
        Effect.flip(service.decide({ ...input, contentFingerprint: "different" }, false)),
      )
    ).code,
  ).toBe("InvalidInput");
  expect(await runtime.runPromise(service.list())).toEqual([]);
});
