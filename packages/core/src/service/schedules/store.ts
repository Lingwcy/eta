import { Context, Effect, Layer, Schema } from "effect";
import { AppPathsService } from "../../platform/app-paths.ts";
import { ScheduleStoreSchema, type ScheduleStoreState } from "../../shared/schedules.ts";
import { CoreError } from "../errors.ts";
import { readJson, writeJson } from "../json-file.ts";

const decode = Schema.decodeUnknownSync(ScheduleStoreSchema, { onExcessProperty: "error" });
export function emptyScheduleStore(): ScheduleStoreState {
  return {
    version: 1,
    revision: 0,
    schedules: {},
    occurrences: {},
    proposals: {},
    requests: {},
    lifecycleIntents: {},
  };
}

/** Validate disk and transaction output before replacement; corrupt stores are never reset. */
export function decodeScheduleStore(input: unknown): ScheduleStoreState {
  try {
    const state = decode(input);
    for (const [id, schedule] of Object.entries(state.schedules)) {
      if (id !== schedule.id) throw new Error("Schedule key mismatch");
      if (
        (schedule.state !== "active" || schedule.deletedAt !== undefined) &&
        schedule.nextRunAt !== null
      )
        throw new Error("Inactive schedule has a future slot");
      if (
        schedule.nextRunAt !== null &&
        schedule.consumedThrough !== null &&
        schedule.nextRunAt <= schedule.consumedThrough
      )
        throw new Error("Schedule cursor moved backwards");
    }
    const deliveries = new Set<string>();
    for (const [id, occurrence] of Object.entries(state.occurrences)) {
      const schedule = state.schedules[occurrence.scheduleId];
      if (
        id !== occurrence.id ||
        !schedule ||
        schedule.threadId !== occurrence.threadId ||
        occurrence.scheduleRevision > schedule.revision
      )
        throw new Error("Invalid occurrence relation");
      if (deliveries.has(occurrence.requestId)) throw new Error("Duplicate delivery identity");
      deliveries.add(occurrence.requestId);
      if (["admitted", "succeeded", "failed"].includes(occurrence.state) && !occurrence.operationId)
        throw new Error("Missing admission receipt");
    }
    for (const [id, proposal] of Object.entries(state.proposals)) {
      if (id !== proposal.id || proposal.expiresAt <= proposal.createdAt)
        throw new Error("Invalid proposal identity or expiry");
      if (
        proposal.change.action !== "create" &&
        state.schedules[proposal.change.scheduleId]?.threadId !== proposal.threadId
      )
        throw new Error("Invalid proposal target");
      if (
        proposal.state === "approved" &&
        (!proposal.decisionRequestId ||
          !proposal.scheduleId ||
          state.requests[proposal.decisionRequestId]?.state !== "applied")
      )
        throw new Error("Missing approval receipt");
    }
    for (const [id, request] of Object.entries(state.requests)) {
      if (id !== request.requestId) throw new Error("Request key mismatch");
      if (request.scheduleId && state.schedules[request.scheduleId]?.threadId !== request.threadId)
        throw new Error("Invalid request schedule");
      if (request.proposalId && state.proposals[request.proposalId]?.threadId !== request.threadId)
        throw new Error("Invalid request proposal");
      if (
        request.occurrenceId &&
        state.occurrences[request.occurrenceId]?.threadId !== request.threadId
      )
        throw new Error("Invalid request occurrence");
    }
    for (const [id, intent] of Object.entries(state.lifecycleIntents)) {
      if (
        id !== intent.requestId ||
        state.requests[id]?.state !== "pending" ||
        state.requests[id]?.threadId !== intent.threadId
      )
        throw new Error("Invalid lifecycle receipt");
    }
    return state;
  } catch {
    throw new CoreError({ code: "StorageCorrupt", message: "定时任务记录格式或关系无效" });
  }
}

/** One host owns a data root. The host lock must be acquired before opening this service. */
export class ScheduleStoreService extends Context.Service<
  ScheduleStoreService,
  {
    readonly read: Effect.Effect<ScheduleStoreState, CoreError>;
    update(
      change: (state: ScheduleStoreState) => ScheduleStoreState,
    ): Effect.Effect<ScheduleStoreState, CoreError>;
  }
>()("eta/core/service/schedules/ScheduleStoreService") {
  static readonly layer = Layer.effect(
    ScheduleStoreService,
    Effect.gen(function* () {
      const { scheduleStorePath } = yield* AppPathsService;
      let queue = Promise.resolve();
      const load = async () => {
        const raw = await readJson(scheduleStorePath);
        return raw === undefined ? emptyScheduleStore() : decodeScheduleStore(raw);
      };
      const storageError = (error: unknown) =>
        error instanceof CoreError
          ? error
          : new CoreError({ code: "StorageUnavailable", message: "无法访问定时任务记录" });
      return ScheduleStoreService.of({
        read: Effect.tryPromise({
          try: async () => {
            await queue;
            return load();
          },
          catch: storageError,
        }),
        update: (change) =>
          Effect.tryPromise({
            try: () => {
              const next = queue.then(async () => {
                const previous = await load();
                const changed = change(previous);
                const state = decodeScheduleStore({ ...changed, revision: previous.revision + 1 });
                await writeJson(scheduleStorePath, state);
                return state;
              });
              queue = next.then(
                () => undefined,
                () => undefined,
              );
              return next;
            },
            catch: storageError,
          }).pipe(Effect.uninterruptible),
      });
    }),
  );
}
