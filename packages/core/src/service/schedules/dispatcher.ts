import { Context, DateTime, Effect, Fiber, Layer, Option, Queue, Semaphore } from "effect";
import type { OperationAdmission, OperationResult } from "../../agent/protocol.ts";
import type { ScheduleOccurrence } from "../../shared/schedules.ts";
import { CatalogService } from "../catalog/index.ts";
import { CoreError } from "../errors.ts";
import { ScheduleGateService } from "./gate.ts";
import { reconcileScheduleLifecycles } from "./lifecycle.ts";
import { scheduleDraft, settleScheduleRequests, type ScheduleDraft } from "./management.ts";
import {
  discoverScheduleOccurrences,
  finishOccurrence,
  markScheduleBlocked,
  nextPendingOccurrence,
  pendingOccurrenceReason,
  scheduleThreadIds,
} from "./occurrences.ts";
import { ScheduleStoreService } from "./store.ts";

export type ScheduleAdmissionResult =
  | { status: "admitted"; admission: OperationAdmission }
  | { status: "blocked"; reason: string }
  | { status: "unknown"; reason: string };
export type ScheduleAdmissionLookup =
  | { status: "admitted"; operation: OperationResult; reason?: string }
  | { status: "absent"; settled: boolean }
  | { status: "unknown"; reason: string };
export interface ScheduleHostAdapter {
  submit(input: {
    threadId: string;
    prompt: string;
    requestId: string;
  }): Promise<ScheduleAdmissionResult>;
  /** settled=true is proof no prior admission call can still commit this request. */
  lookup(input: { threadId: string; requestId: string }): Promise<ScheduleAdmissionLookup>;
  validate(threadId: string): Promise<string | undefined>;
  subscribe?(listener: () => void): () => void;
}

type Flight = {
  waiting?: boolean;
  promise: Promise<ScheduleAdmissionResult>;
  outcome?: ScheduleAdmissionResult;
};

export class ScheduleDispatcherService extends Context.Service<
  ScheduleDispatcherService,
  {
    start(host: ScheduleHostAdapter): Effect.Effect<void, CoreError>;
    stop: Effect.Effect<void, CoreError>;
    /** A deterministic pass is also used by focused clock/crash tests. No model completion is awaited. */
    tick(host: ScheduleHostAdapter, at?: number): Effect.Effect<void, CoreError>;
  }
>()("eta/core/service/schedules/ScheduleDispatcherService") {
  static readonly layer = Layer.effect(
    ScheduleDispatcherService,
    Effect.gen(function* () {
      const store = yield* ScheduleStoreService;
      const catalog = yield* CatalogService;
      const gate = yield* ScheduleGateService;
      const scope = yield* Effect.scope;
      const signals = yield* Queue.sliding<void>(1);
      const ticking = Semaphore.makeUnsafe(1);
      const lifecycle = Semaphore.makeUnsafe(1);
      const flights = new Map<string, Flight>();
      let loop: Fiber.Fiber<void, never> | undefined;
      let activeHost: ScheduleHostAdapter | undefined;
      let stopHostWatch: (() => void) | undefined;
      let stopping = false;
      const unsubscribe = store.subscribe((origin) => {
        if (origin !== "dispatcher") Queue.offerUnsafe(signals, undefined);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      const nowMillis = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      const save = (change: (draft: ScheduleDraft) => void) =>
        store.update((state) => {
          const draft = scheduleDraft(state);
          change(draft);
          return draft;
        }, "dispatcher");
      const outcome = Effect.fn("ScheduleDispatcher.outcome")(function* (
        occurrence: ScheduleOccurrence,
        result: ScheduleAdmissionResult,
      ) {
        yield* save((state) => {
          const current = state.occurrences[occurrence.id];
          if (!current || current.state !== "dispatching") return;
          const { reason: _reason, ...withoutReason } = current;
          if (result.status === "admitted")
            state.occurrences[current.id] = {
              ...withoutReason,
              state: "admitted",
              operationId: result.admission.operationId,
              admittedAt: result.admission.startedAt,
            };
          else
            state.occurrences[current.id] = {
              ...current,
              state: result.status === "blocked" ? "pending" : "dispatching",
              reason: result.reason,
            };
          const schedule = state.schedules[current.scheduleId];
          if (schedule)
            markScheduleBlocked(
              state,
              schedule,
              result.status === "admitted" ? undefined : result.reason,
            );
        });
        flights.delete(occurrence.requestId);
      });
      const reconcile = Effect.fn("ScheduleDispatcher.reconcile")(function* (
        host: ScheduleHostAdapter,
        occurrence: ScheduleOccurrence,
        now: number,
      ) {
        const flight = flights.get(occurrence.requestId);
        if (flight && !flight.outcome) return;
        if (flight?.outcome && flight.outcome.status !== "unknown") {
          yield* outcome(occurrence, flight.outcome);
          return;
        }
        const found = yield* Effect.promise(() =>
          host
            .lookup({ threadId: occurrence.threadId, requestId: occurrence.requestId })
            .catch((): ScheduleAdmissionLookup => ({
              status: "unknown",
              reason: "admissionUnknown",
            })),
        ).pipe(
          Effect.interruptible,
          Effect.timeoutOption(5_000),
          Effect.map(
            Option.getOrElse((): ScheduleAdmissionLookup => ({
              status: "unknown",
              reason: "admissionUnknown",
            })),
          ),
        );
        yield* save((state) => {
          const current = state.occurrences[occurrence.id];
          if (!current || !["dispatching", "admitted"].includes(current.state)) return;
          if (found.status === "admitted") {
            const { reason: _reason, ...withoutReason } = current;
            const admitted = {
              ...withoutReason,
              state: "admitted" as const,
              operationId: found.operation.operationId,
              admittedAt: found.operation.startedAt,
            };
            const status = found.operation.status;
            if (["completed", "failed", "aborted"].includes(status))
              finishOccurrence(
                state,
                admitted,
                status === "completed"
                  ? "succeeded"
                  : status === "aborted"
                    ? "cancelled"
                    : "failed",
                found.operation.endedAt ?? now,
                found.operation.error,
              );
            else
              state.occurrences[current.id] = {
                ...admitted,
                ...(found.reason ? { reason: found.reason } : {}),
              };
            const schedule = state.schedules[current.scheduleId];
            if (schedule) markScheduleBlocked(state, schedule, found.reason);
          } else if (
            found.status === "absent" &&
            found.settled &&
            current.state === "dispatching"
          ) {
            state.occurrences[current.id] = {
              ...current,
              state: "pending",
              reason: "admissionNotFound",
            };
          } else {
            state.occurrences[current.id] = {
              ...current,
              reason: found.status === "unknown" ? found.reason : "admissionUnknown",
            };
          }
        });
        if (flight?.outcome) flights.delete(occurrence.requestId);
      });
      const processThread = Effect.fn("ScheduleDispatcher.processThread")(function* (
        host: ScheduleHostAdapter,
        threadId: string,
        now: number,
      ) {
        const initial = yield* store.read;
        for (const occurrence of Object.values(initial.occurrences)) {
          if (
            occurrence.threadId === threadId &&
            ["dispatching", "admitted"].includes(occurrence.state)
          )
            yield* reconcile(host, occurrence, now);
        }
        const currentCatalog = yield* catalog.read;
        yield* save((state) => {
          reconcileScheduleLifecycles(state, currentCatalog, now, threadId);
          settleScheduleRequests(state, threadId, currentCatalog, now);
          for (const [id, proposal] of Object.entries(state.proposals)) {
            if (
              proposal.threadId === threadId &&
              proposal.state === "pending" &&
              proposal.expiresAt <= now
            )
              state.proposals[id] = { ...proposal, state: "expired", reason: "确认期限已过" };
          }
          const thread = currentCatalog.threads.find((thread) => thread.id === threadId);
          if (!thread || thread.archivedAt !== undefined || stopping) return;
          discoverScheduleOccurrences(state, threadId, now);
          for (const occurrence of Object.values(state.occurrences)) {
            if (occurrence.threadId !== threadId || occurrence.state !== "pending") continue;
            const reason = pendingOccurrenceReason(state, occurrence, now);
            if (reason)
              finishOccurrence(
                state,
                occurrence,
                reason === "missed" ? "skipped" : "cancelled",
                now,
                reason,
              );
          }
        });
        if (stopping) return;
        const current = scheduleDraft(yield* store.read);
        const pending = nextPendingOccurrence(current, threadId);
        if (!pending) return;
        const blocked = yield* Effect.promise(() =>
          host.validate(threadId).catch(() => "workspaceUnavailable"),
        ).pipe(
          Effect.interruptible,
          Effect.timeoutOption(5_000),
          Effect.map(Option.getOrElse(() => "workspaceUnavailable")),
        );
        if (blocked) {
          yield* save((state) => {
            const schedule = state.schedules[pending.scheduleId];
            if (schedule) markScheduleBlocked(state, schedule, blocked);
            state.occurrences[pending.id] = { ...state.occurrences[pending.id], reason: blocked };
          });
          return;
        }
        // The thread gate spans this final check, durable intention, and admission receipt boundary.
        const ready = yield* save((state) => {
          const selected = nextPendingOccurrence(state, threadId);
          if (selected?.id === pending.id && !pendingOccurrenceReason(state, selected, now))
            state.occurrences[selected.id] = {
              ...selected,
              state: "dispatching",
              reason: "admissionUnknown",
            };
        });
        const dispatching = ready.occurrences[pending.id];
        if (dispatching.state !== "dispatching" || stopping) return;
        const flight: Flight = {
          promise: Promise.resolve({ status: "unknown", reason: "admissionUnknown" }),
        };
        flight.promise = Promise.resolve()
          .then(() =>
            host.submit({ threadId, prompt: dispatching.prompt, requestId: dispatching.requestId }),
          )
          .catch((): ScheduleAdmissionResult => ({ status: "unknown", reason: "admissionUnknown" }))
          .then((result) => {
            flight.outcome = result;
            if (flight.waiting) Queue.offerUnsafe(signals, undefined);
            return result;
          });
        flights.set(dispatching.requestId, flight);
        const admitted = yield* Effect.promise(() => flight.promise).pipe(
          Effect.interruptible,
          Effect.timeoutOption(1_000),
        );
        if (Option.isSome(admitted)) yield* outcome(dispatching, admitted.value);
        else {
          flight.waiting = true;
          if (flight.outcome) Queue.offerUnsafe(signals, undefined);
        }
      });
      const tick = Effect.fn("ScheduleDispatcher.tick")((host: ScheduleHostAdapter, at?: number) =>
        ticking.withPermit(
          Effect.gen(function* () {
            const now = at ?? (yield* nowMillis);
            const state = scheduleDraft(yield* store.read);
            yield* Effect.forEach(
              scheduleThreadIds(state),
              (threadId) => gate.withThread(threadId, processThread(host, threadId, now)),
              { concurrency: 8, discard: true },
            );
          }).pipe(Effect.uninterruptible),
        ),
      );
      const stop = lifecycle.withPermit(
        Effect.gen(function* () {
          stopping = true;
          stopHostWatch?.();
          stopHostWatch = undefined;
          if (loop) yield* Fiber.interrupt(loop);
          loop = undefined;
          // Complete in-flight host calls before its Controller/Core can be closed.
          yield* Effect.promise(() =>
            Promise.all([...flights.values()].map((flight) => flight.promise)),
          );
          if (activeHost) yield* tick(activeHost);
          activeHost = undefined;
        }).pipe(Effect.uninterruptible),
      );
      yield* Effect.addFinalizer(() =>
        stop.pipe(Effect.catch((error) => Effect.logError(error.message))),
      );
      const start = (host: ScheduleHostAdapter) =>
        lifecycle.withPermit(
          Effect.gen(function* () {
            if (loop)
              return yield* new CoreError({ code: "Busy", message: "定时任务调度器已经启动" });
            stopping = false;
            activeHost = host;
            stopHostWatch = host.subscribe?.(() => {
              Queue.offerUnsafe(signals, undefined);
            });
            const run = Effect.gen(function* () {
              while (!stopping) {
                yield* tick(host).pipe(Effect.catch((error) => Effect.logError(error.message)));
                const state = yield* store.read.pipe(Effect.catch(() => Effect.succeed(undefined)));
                const now = yield* nowMillis;
                const times = state
                  ? Object.values(state.schedules).flatMap((schedule) =>
                      schedule.state === "active" && schedule.nextRunAt !== null
                        ? [schedule.nextRunAt]
                        : [],
                    )
                  : [];
                const hasPending =
                  state &&
                  Object.values(state.occurrences).some((occurrence) =>
                    ["pending", "dispatching", "admitted"].includes(occurrence.state),
                  );
                const delay = Math.max(
                  1_000,
                  Math.min(
                    hasPending ? 15_000 : 60_000,
                    ...times.filter((time) => time > now).map((time) => time - now),
                  ),
                );
                yield* Effect.raceFirst(Effect.sleep(delay), Queue.take(signals));
              }
            });
            loop = yield* Effect.forkIn(run, scope);
          }),
        );
      return ScheduleDispatcherService.of({ start, stop, tick });
    }),
  );
}
