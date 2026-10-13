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
