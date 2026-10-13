import { randomUUID } from "node:crypto";
import { Context, DateTime, Effect, Exit, Layer } from "effect";
import type { OperationResult } from "../../agent/protocol.ts";
import type { ScheduleOccurrence } from "../../shared/schedules.ts";
import { finishOccurrence } from "./occurrences.ts";
import type { CatalogState } from "../../shared/catalog.ts";
import { CatalogService } from "../catalog/index.ts";
import { CoreError } from "../errors.ts";
import { ScheduleGateService } from "./gate.ts";
import { scheduleDraft, scheduleFingerprint, type ScheduleDraft } from "./management.ts";
import { ScheduleStoreService } from "./store.ts";

/** Catalog success is the authority; unarchive never reactivates the paused schedules. */
export function finishScheduleLifecycle(
  state: ScheduleDraft,
  threadId: string,
  action: "archive" | "delete",
  now: number,
) {
  for (const [id, schedule] of Object.entries(state.schedules)) {
    if (schedule.threadId !== threadId || schedule.deletedAt !== undefined) continue;
    if (action === "delete" || schedule.state === "active")
      state.schedules[id] = {
        ...schedule,
        state: "paused",
        nextRunAt: null,
        revision: schedule.revision + 1,
        updatedAt: now,
        ...(action === "delete" ? { deletedAt: now } : {}),
      };
  }
  for (const [id, occurrence] of Object.entries(state.occurrences)) {
    if (occurrence.threadId === threadId && occurrence.state === "pending")
      state.occurrences[id] = {
        ...occurrence,
        state: "cancelled",
        reason: action,
        finishedAt: now,
      };
  }
  for (const [id, proposal] of Object.entries(state.proposals)) {
    if (proposal.threadId === threadId && proposal.state === "pending")
      state.proposals[id] = { ...proposal, state: "invalidated", reason: action };
  }
  for (const [id, request] of Object.entries(state.requests)) {
    if (request.threadId === threadId && request.state === "pending" && !state.lifecycleIntents[id])
      state.requests[id] = { ...request, state: "rejected", reason: action, finishedAt: now };
  }
}

/** Only at startup or inside the gate after the previous lifecycle call has ended. */
export function reconcileScheduleLifecycles(
  state: ScheduleDraft,
  catalog: CatalogState,
  now: number,
  onlyThread?: string,
) {
  for (const [id, intent] of Object.entries(state.lifecycleIntents)) {
    if (onlyThread && intent.threadId !== onlyThread) continue;
    const thread = catalog.threads.find((thread) => thread.id === intent.threadId);
    const applied =
      intent.action === "delete" ? !thread : !thread || thread.archivedAt !== undefined;
    if (
      Object.values(state.occurrences).some(
        (occurrence) =>
          occurrence.threadId === intent.threadId && occurrence.state === "dispatching",
      )
    )
      continue;
    if (applied)
      finishScheduleLifecycle(state, intent.threadId, !thread ? "delete" : "archive", now);
    state.requests[id] = {
      ...state.requests[id],
      state: applied ? "applied" : "rejected",
      finishedAt: now,
      ...(applied ? {} : { reason: "会话生命周期操作未生效" }),
    };
    delete state.lifecycleIntents[id];
  }
  // Repair archived/orphan schedules even when older hosts did not save an intention.
  const ids = new Set([
    ...Object.values(state.schedules)
      .filter((schedule) => schedule.deletedAt === undefined)
      .map((schedule) => schedule.threadId),
    ...Object.values(state.proposals)
      .filter((proposal) => proposal.state === "pending")
      .map((proposal) => proposal.threadId),
  ]);
  for (const threadId of ids) {
    if (onlyThread && onlyThread !== threadId) continue;
    if (
      Object.values(state.occurrences).some(
        (occurrence) => occurrence.threadId === threadId && occurrence.state === "dispatching",
      )
    )
      continue;
    const thread = catalog.threads.find((thread) => thread.id === threadId);
    if (!thread || thread.archivedAt !== undefined)
      finishScheduleLifecycle(state, threadId, thread ? "archive" : "delete", now);
  }
}

export class ScheduleLifecycleService extends Context.Service<
  ScheduleLifecycleService,
  {
    admitted(threadId: string): Effect.Effect<readonly ScheduleOccurrence[], CoreError>;
    recordResults(
      threadId: string,
      results: readonly OperationResult[],
    ): Effect.Effect<void, CoreError>;
    coordinate<A, E, R>(
      threadId: string,
      action: "archive" | "delete" | "restore",
      operation: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | CoreError, R>;
  }
>()("eta/core/service/schedules/ScheduleLifecycleService") {
  static readonly layer = Layer.effect(
    ScheduleLifecycleService,
    Effect.gen(function* () {
      const store = yield* ScheduleStoreService;
      const catalog = yield* CatalogService;
      const gate = yield* ScheduleGateService;
      const repair = Effect.fn("ScheduleLifecycleService.repair")(function* (onlyThread?: string) {
        const currentCatalog = yield* catalog.read;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const current = yield* store.read;
        const draft = scheduleDraft(current);
        reconcileScheduleLifecycles(draft, currentCatalog, now, onlyThread);
        if (JSON.stringify(draft) !== JSON.stringify(current))
          yield* store.update((latest) => {
            const repaired = scheduleDraft(latest);
            reconcileScheduleLifecycles(repaired, currentCatalog, now, onlyThread);
            return repaired;
          });
      });
      yield* repair();
      return ScheduleLifecycleService.of({
        admitted: (threadId) =>
          store.read.pipe(
            Effect.map((state) =>
              Object.values(state.occurrences).filter(
                (occurrence) => occurrence.threadId === threadId && occurrence.state === "admitted",
              ),
            ),
          ),
        recordResults: (threadId, results) =>
          Effect.gen(function* () {
            if (
              results.some((result) => !["completed", "failed", "aborted"].includes(result.status))
            )
              return yield* new CoreError({ code: "Busy", message: "请先处理未完成的定时任务" });
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            yield* store.update((state) => {
              const draft = scheduleDraft(state);
              for (const occurrence of Object.values(draft.occurrences)) {
                if (occurrence.threadId !== threadId || occurrence.state !== "admitted") continue;
                const result = results.find(
                  (result) => result.operationId === occurrence.operationId,
                );
                if (result)
                  finishOccurrence(
                    draft,
                    occurrence,
                    result.status === "completed"
                      ? "succeeded"
                      : result.status === "aborted"
                        ? "cancelled"
                        : "failed",
                    result.endedAt ?? now,
                    result.error,
                  );
              }
              return draft;
            });
          }),
        coordinate: (threadId, action, operation) =>
          gate.withThread(
            threadId,
            Effect.gen(function* () {
              yield* repair(threadId);
              const before = yield* store.read;
              if (
                Object.values(before.occurrences).some(
                  (occurrence) =>
                    occurrence.threadId === threadId && occurrence.state === "dispatching",
                ) ||
                Object.values(before.lifecycleIntents).some(
                  (intent) => intent.threadId === threadId,
                )
              )
                return yield* new CoreError({
                  code: "Busy",
                  message: "定时任务投递结果正在核对，请稍后重试",
                });
              if (action === "restore") return yield* operation;
              const requestId = randomUUID();
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              const workspaceId = (yield* catalog.read).threads.find(
                (thread) => thread.id === threadId,
              )?.workspaceId;
              const workspace = workspaceId ? { workspaceId } : {};
              yield* store.update((current) => {
                const draft = scheduleDraft(current);
                draft.requests[requestId] = {
                  requestId,
                  threadId,
                  ...workspace,
                  fingerprint: scheduleFingerprint({ kind: "lifecycle", threadId, action }),
                  state: "pending",
                  createdAt: now,
                };
                draft.lifecycleIntents[requestId] = {
                  requestId,
                  threadId,
                  action,
                  ...workspace,
                  phase: "prepared",
                  createdAt: now,
                };
                return draft;
              });
              const exit = yield* Effect.exit(operation);
              // A failed/uncertain write keeps its intention until Catalog is re-read on repair.
              // Known Busy and NotFound refusals are safe to reconcile against the unchanged Catalog.
              if (Exit.isFailure(exit)) {
                const error = Exit.findErrorOption(exit);
                if (
                  error._tag === "Some" &&
                  error.value instanceof CoreError &&
                  ["Busy", "NotFound", "InvalidInput"].includes(error.value.code)
                )
                  yield* repair(threadId);
                return yield* Effect.failCause(exit.cause);
              }
              const finishedAt = DateTime.toEpochMillis(yield* DateTime.now);
              yield* store.update((current) => {
                const draft = scheduleDraft(current);
                finishScheduleLifecycle(draft, threadId, action, finishedAt);
                draft.requests[requestId] = {
                  ...draft.requests[requestId],
                  state: "applied",
                  finishedAt,
                };
                delete draft.lifecycleIntents[requestId];
                return draft;
              });
              return exit.value;
            }).pipe(Effect.uninterruptible),
          ),
      });
    }),
  );
}
