import { DateTime, Option, Schema } from "effect";

export const MIN_SCHEDULE_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_MISSED_WINDOW_MS = 24 * 60 * 60_000;
export const DEFAULT_PROPOSAL_TTL_MS = DEFAULT_MISSED_WINDOW_MS;
export const MAX_THREAD_SCHEDULES = 20;
export const MAX_HOST_SCHEDULES = 200;

export const ScheduleTimestampSchema = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }),
);
const TimeSchema = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
const TimeZoneSchema = Schema.NonEmptyString.check(
  Schema.makeFilter((zone) => Option.isSome(DateTime.zoneMakeNamed(zone)), {
    message: "Expected a valid IANA time zone",
  }),
);
const WeekdaysSchema = Schema.Array(
  Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
).check(
  Schema.makeFilter((days) => days.length > 0 && new Set(days).size === days.length, {
    message: "Expected distinct weekdays (0 = Sunday, 6 = Saturday)",
  }),
);
export const ScheduleRuleSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: ScheduleTimestampSchema }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    everyMs: Schema.Int.check(
      Schema.isBetween({ minimum: MIN_SCHEDULE_INTERVAL_MS, maximum: 8_640_000_000_000_000 }),
    ),
    anchorAt: ScheduleTimestampSchema,
  }),
  Schema.Struct({ type: Schema.Literal("daily"), time: TimeSchema, timeZone: TimeZoneSchema }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    weekdays: WeekdaysSchema,
    time: TimeSchema,
    timeZone: TimeZoneSchema,
  }),
]);
export type ScheduleRule = typeof ScheduleRuleSchema.Type;

export const ScheduleNameSchema = Schema.NonEmptyString.check(Schema.isPattern(/\S/));
export const SchedulePromptSchema = Schema.NonEmptyString.check(Schema.isPattern(/\S/));
const Id = Schema.NonEmptyString;
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Timestamp = ScheduleTimestampSchema;
export const SchedulePatchSchema = Schema.Struct({
  name: Schema.optionalKey(ScheduleNameSchema),
  prompt: Schema.optionalKey(SchedulePromptSchema),
  rule: Schema.optionalKey(ScheduleRuleSchema),
});
export const ScheduleChangeSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("create"),
    name: ScheduleNameSchema,
    prompt: SchedulePromptSchema,
    rule: ScheduleRuleSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    scheduleId: Id,
    expectedRevision: Revision,
    patch: SchedulePatchSchema,
  }),
  Schema.Struct({
    action: Schema.Literals(["pause", "resume", "delete"]),
    scheduleId: Id,
    expectedRevision: Revision,
  }),
]);
export type ScheduleChange = typeof ScheduleChangeSchema.Type;

export const ScheduleSchema = Schema.Struct({
  id: Id,
  threadId: Id,
  // Retained scope identity for history after thread deletion; execution resolves the current thread.
  workspaceId: Schema.optionalKey(Id),
  name: ScheduleNameSchema,
  prompt: SchedulePromptSchema,
  rule: ScheduleRuleSchema,
  state: Schema.Literals(["active", "paused", "completed"]),
  nextRunAt: Schema.NullOr(Timestamp),
  consumedThrough: Schema.NullOr(Timestamp),
  revision: Revision,
  missedWindowMs: Schema.Int.check(Schema.isGreaterThan(0)),
  source: Schema.Literals(["user", "agent"]),
  blockedReason: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletedAt: Schema.optionalKey(Timestamp),
});
export type Schedule = typeof ScheduleSchema.Type;

export const ScheduleOccurrenceSchema = Schema.Struct({
  id: Id,
  scheduleId: Id,
  threadId: Id,
  scheduleRevision: Revision,
  scheduledAt: Timestamp,
  source: Schema.Literals(["automatic", "manual"]),
  name: ScheduleNameSchema,
  prompt: SchedulePromptSchema,
  rule: ScheduleRuleSchema,
  requestId: Id,
  detectedAt: Timestamp,
  admittedAt: Schema.optionalKey(Timestamp),
  operationId: Schema.optionalKey(Id),
  inputEntryId: Schema.optionalKey(Id),
  finishedAt: Schema.optionalKey(Timestamp),
  state: Schema.Literals([
    "pending",
    "dispatching",
    "admitted",
    "succeeded",
    "failed",
    "cancelled",
    "skipped",
  ]),
  reason: Schema.optionalKey(Schema.NonEmptyString),
  supersededFrom: Schema.optionalKey(Timestamp),
});
export type ScheduleOccurrence = typeof ScheduleOccurrenceSchema.Type;

export const ScheduleProposalSchema = Schema.Struct({
  id: Id,
  threadId: Id,
  change: ScheduleChangeSchema,
  workspaceId: Id,
  contentFingerprint: Id,
  sourceIdentity: Id,
  createdAt: Timestamp,
  expiresAt: Timestamp,
  state: Schema.Literals(["pending", "approved", "rejected", "invalidated", "expired"]),
  reason: Schema.optionalKey(Schema.NonEmptyString),
  scheduleId: Schema.optionalKey(Id),
  decisionRequestId: Schema.optionalKey(Id),
});
export type ScheduleProposal = typeof ScheduleProposalSchema.Type;

export const ScheduleRequestSchema = Schema.Struct({
  requestId: Id,
  threadId: Id,
  workspaceId: Schema.optionalKey(Id),
  fingerprint: Id,
  state: Schema.Literals(["pending", "applied", "rejected"]),
  change: Schema.optionalKey(ScheduleChangeSchema),
  scheduleId: Schema.optionalKey(Id),
  proposalId: Schema.optionalKey(Id),
  occurrenceId: Schema.optionalKey(Id),
  nextRunAt: Schema.optionalKey(Schema.NullOr(Timestamp)),
  reason: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: Timestamp,
  finishedAt: Schema.optionalKey(Timestamp),
});
export type ScheduleRequest = typeof ScheduleRequestSchema.Type;

export const ScheduleLifecycleIntentSchema = Schema.Struct({
  requestId: Id,
  threadId: Id,
  action: Schema.Literals(["archive", "delete"]),
  workspaceId: Schema.optionalKey(Id),
  phase: Schema.Literals(["prepared", "catalogApplied"]),
  createdAt: Timestamp,
});
export type ScheduleLifecycleIntent = typeof ScheduleLifecycleIntentSchema.Type;

/** Compact chat provenance survives pruning of full run history; it contains no execution prompt. */
export const ScheduleMessageOriginSchema = Schema.Struct({
  occurrenceId: Id,
  scheduleId: Id,
  threadId: Id,
  inputEntryId: Id,
  operationId: Id,
  requestId: Id,
  name: ScheduleNameSchema,
  scheduledAt: Timestamp,
});
export type ScheduleMessageOrigin = typeof ScheduleMessageOriginSchema.Type;

export const ScheduleStoreSchema = Schema.Struct({
  version: Schema.Literal(1),
  messageOrigins: Schema.optionalKey(Schema.Record(Id, ScheduleMessageOriginSchema)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  schedules: Schema.Record(Id, ScheduleSchema),
  occurrences: Schema.Record(Id, ScheduleOccurrenceSchema),
  proposals: Schema.Record(Id, ScheduleProposalSchema),
  requests: Schema.Record(Id, ScheduleRequestSchema),
  lifecycleIntents: Schema.Record(Id, ScheduleLifecycleIntentSchema),
});
export type ScheduleStoreState = typeof ScheduleStoreSchema.Type;

export const ScheduleSnapshotSchema = Schema.Struct({
  messageOrigins: Schema.optionalKey(Schema.Array(ScheduleMessageOriginSchema)),
  occurrences: Schema.optionalKey(Schema.Array(ScheduleOccurrenceSchema)),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  schedules: Schema.Array(ScheduleSchema),
  proposals: Schema.Array(ScheduleProposalSchema),
  requests: Schema.Array(ScheduleRequestSchema),
  lifecycleIntents: Schema.Array(ScheduleLifecycleIntentSchema),
});
export type ScheduleSnapshot = typeof ScheduleSnapshotSchema.Type;

/** Durable tool observation for the chat notice; controls resolve its request in the current thread. */
export const ScheduleToolResultSchema = Schema.Struct({
  kind: Schema.Literal("schedule"),
  requestId: Id,
  threadId: Id,
  action: Schema.Literals(["create", "update", "pause", "resume", "delete"]),
  status: Schema.Literals(["pending", "applied"]),
  scheduleId: Schema.optional(Id),
  name: Schema.optional(ScheduleNameSchema),
  rule: Schema.optional(ScheduleRuleSchema),
  nextRunAt: Schema.NullOr(Timestamp),
});
export type ScheduleToolResult = typeof ScheduleToolResultSchema.Type;
