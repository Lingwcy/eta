import { Context, DateTime, Effect, Layer, Schema } from "effect";
import type {
  Schedule,
  ScheduleOccurrence,
  ScheduleProposal,
  ScheduleRequest,
  ScheduleSnapshot,
} from "../../shared/schedules.ts";
import { CatalogService } from "../catalog/index.ts";
import { CoreEnvironmentService } from "../environment.ts";
import { adapter, CoreError } from "../errors.ts";
import { WorkspaceService } from "../workspaces/index.ts";
import { ScheduleGateService } from "./gate.ts";
import {
  ScheduleWriteInputSchema,
  ScheduleProposeInputSchema,
  ScheduleDecisionInputSchema,
  ScheduleRunInputSchema,
  writeScheduleChange,
  proposeScheduleChange,
  decideScheduleProposal,
  runScheduleNow,
  scheduleDraft,
  type ScheduleWriteInput,
  type ScheduleProposeInput,
  type ScheduleDecisionInput,
  type ScheduleRunInput,
} from "./management.ts";
import { ScheduleStoreService } from "./store.ts";

export class ScheduleService extends Context.Service<
  ScheduleService,
  {
    readonly snapshot: Effect.Effect<ScheduleSnapshot, CoreError>;
    list(threadId?: string): Effect.Effect<readonly Schedule[], CoreError>;
    proposals(threadId?: string): Effect.Effect<readonly ScheduleProposal[], CoreError>;
    runs(scheduleId: string): Effect.Effect<readonly ScheduleOccurrence[], CoreError>;
    request(requestId: string): Effect.Effect<ScheduleRequest | undefined, CoreError>;
    write(input: ScheduleWriteInput): Effect.Effect<ScheduleRequest, CoreError>;
    propose(input: ScheduleProposeInput): Effect.Effect<ScheduleRequest, CoreError>;
    decide(
      input: ScheduleDecisionInput,
      approved: boolean,
    ): Effect.Effect<ScheduleRequest, CoreError>;
    runNow(input: ScheduleRunInput): Effect.Effect<ScheduleRequest, CoreError>;
    subscribe(listener: () => void): () => void;
  }
>()("eta/core/service/schedules/ScheduleService") {
  static readonly layer = Layer.effect(
    ScheduleService,
    Effect.gen(function* () {
      const store = yield* ScheduleStoreService;
      const catalog = yield* CatalogService;
      const workspaces = yield* WorkspaceService;
      const gate = yield* ScheduleGateService;
      const environment = yield* CoreEnvironmentService;
      // Fail startup on corrupt storage before any host starts its dispatcher.
      yield* store.read;
      const decodeOptions = { onExcessProperty: "error" as const };
      const inputError = (error: { message: string }) =>
        new CoreError({ code: "InvalidInput", message: error.message });
      const decodeWrite = Schema.decodeUnknownEffect(ScheduleWriteInputSchema, decodeOptions);
      const decodeProposal = Schema.decodeUnknownEffect(ScheduleProposeInputSchema, decodeOptions);
      const decodeDecision = Schema.decodeUnknownEffect(ScheduleDecisionInputSchema, decodeOptions);
      const decodeRun = Schema.decodeUnknownEffect(ScheduleRunInputSchema, decodeOptions);
      const validateWorkspace = Effect.fn("ScheduleService.validateWorkspace")(function* (
        threadId: string,
        requestId: string,
      ) {
        // Accepted request replay must still return its receipt after archival or removal.
        const state = yield* store.read;
        if (state.requests[requestId]) return;
        const thread = (yield* catalog.read).threads.find((thread) => thread.id === threadId);
        if (thread && thread.archivedAt === undefined) {
          yield* adapter(
            "当前宿主不允许此工作区的定时任务",
            () => environment.authorizeScheduleWorkspace(thread.workspaceId),
            "WorkspaceUnavailable",
          );
          yield* workspaces.validate(thread.workspaceId);
        }
      });
      const write = Effect.fn("ScheduleService.write")(function* (raw: ScheduleWriteInput) {
        const input = yield* decodeWrite(raw).pipe(Effect.mapError(inputError));
        return yield* gate.withThread(
          input.threadId,
          Effect.gen(function* () {
            yield* validateWorkspace(input.threadId, input.requestId);
            const currentCatalog = yield* catalog.read;
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const state = yield* store.update((state) => {
              const draft = scheduleDraft(state);
              writeScheduleChange(draft, input, currentCatalog, now);
              return draft;
            });
            return state.requests[input.requestId];
          }),
        );
      });
      const propose = Effect.fn("ScheduleService.propose")(function* (raw: ScheduleProposeInput) {
        const input = yield* decodeProposal(raw).pipe(Effect.mapError(inputError));
        return yield* gate.withThread(
          input.threadId,
          Effect.gen(function* () {
            yield* validateWorkspace(input.threadId, input.requestId);
            const currentCatalog = yield* catalog.read;
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const state = yield* store.update((state) => {
              const draft = scheduleDraft(state);
              proposeScheduleChange(draft, input, currentCatalog, now);
              return draft;
            });
            return state.requests[input.requestId];
          }),
        );
      });
      const decide = Effect.fn("ScheduleService.decide")(function* (
        raw: ScheduleDecisionInput,
        approved: boolean,
      ) {
        const input = yield* decodeDecision(raw).pipe(Effect.mapError(inputError));
        const saved = yield* store.read;
        const proposal = saved.proposals[input.proposalId];
        const prior = saved.requests[input.requestId];
        const threadId = prior?.threadId ?? proposal?.threadId;
        if (!threadId)
          return yield* new CoreError({ code: "NotFound", message: "待确认提案不存在" });
        return yield* gate.withThread(
          threadId,
          Effect.gen(function* () {
            // Rejection can discard proposals after workspace loss; hosts authorize the caller separately.
            if (approved) yield* validateWorkspace(threadId, input.requestId);
            const currentCatalog = yield* catalog.read;
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const state = yield* store.update((state) => {
              const draft = scheduleDraft(state);
              decideScheduleProposal(draft, input, approved, currentCatalog, now);
              return draft;
            });
            return state.requests[input.requestId];
          }),
        );
      });
      const runNow = Effect.fn("ScheduleService.runNow")(function* (raw: ScheduleRunInput) {
        const input = yield* decodeRun(raw).pipe(Effect.mapError(inputError));
        return yield* gate.withThread(
          input.threadId,
          Effect.gen(function* () {
            yield* validateWorkspace(input.threadId, input.requestId);
            const currentCatalog = yield* catalog.read;
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            const state = yield* store.update((state) => {
              const draft = scheduleDraft(state);
              runScheduleNow(draft, input, currentCatalog, now);
              return draft;
            });
            return state.requests[input.requestId];
          }),
        );
      });
      return ScheduleService.of({
        snapshot: store.read.pipe(
          Effect.map((state) => ({
            revision: state.revision,
            messageOrigins: Object.values(state.messageOrigins ?? {}),
            schedules: Object.values(state.schedules),
            occurrences: Object.values(state.occurrences),
            proposals: Object.values(state.proposals),
            requests: Object.values(state.requests).filter(
              (request) => request.state === "pending",
            ),
            lifecycleIntents: Object.values(state.lifecycleIntents),
          })),
        ),
        list: (threadId) =>
          store.read.pipe(
            Effect.map((state) =>
              Object.values(state.schedules).filter(
                (schedule) =>
                  schedule.deletedAt === undefined && (!threadId || schedule.threadId === threadId),
              ),
            ),
          ),
        proposals: (threadId) =>
          store.read.pipe(
            Effect.map((state) =>
              Object.values(state.proposals).filter(
                (proposal) => !threadId || proposal.threadId === threadId,
              ),
            ),
          ),
        runs: (scheduleId) =>
          store.read.pipe(
            Effect.map((state) =>
              Object.values(state.occurrences)
                .filter((occurrence) => occurrence.scheduleId === scheduleId)
                .sort(
                  (left, right) =>
                    right.scheduledAt - left.scheduledAt || left.id.localeCompare(right.id),
                )
                .slice(0, 100),
            ),
          ),
        request: (requestId) => store.read.pipe(Effect.map((state) => state.requests[requestId])),
        write,
        propose,
        decide,
        runNow,
        subscribe: (listener) => store.subscribe(listener),
      });
    }),
  );
}
