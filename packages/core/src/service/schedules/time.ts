import { DateTime } from "effect";
import type { ScheduleRule } from "../../shared/schedules.ts";

/** First slot strictly after the cursor; callers retain the consumed cursor across clock changes. */
export function nextScheduleSlot(rule: ScheduleRule, after: number): number | null {
  switch (rule.type) {
    case "once":
      return rule.at > after ? rule.at : null;
    case "interval": {
      const slot =
        rule.anchorAt +
        Math.max(0, Math.floor((after - rule.anchorAt) / rule.everyMs) + 1) * rule.everyMs;
      return slot <= 8_640_000_000_000_000 ? slot : null;
    }
    default:
      return calendarSlot(rule, after, 1);
  }
}

/** Most recent due slot, without iterating all periods missed during sleep or downtime. */
export function latestScheduleSlot(rule: ScheduleRule, at: number): number | null {
  switch (rule.type) {
    case "once":
      return rule.at <= at ? rule.at : null;
    case "interval":
      return at < rule.anchorAt
        ? null
        : rule.anchorAt + Math.floor((at - rule.anchorAt) / rule.everyMs) * rule.everyMs;
    default:
      return calendarSlot(rule, at, -1);
  }
}

function calendarSlot(
  rule: Extract<ScheduleRule, { type: "daily" | "weekly" }>,
  cursor: number,
  direction: 1 | -1,
): number | null {
  const local = DateTime.toParts(DateTime.makeZonedUnsafe(cursor, { timeZone: rule.timeZone }));
  const [hour, minute] = rule.time.split(":").map(Number);
  const day = DateTime.makeUnsafe({ year: local.year, month: local.month, day: local.day });
  // Walking calendar dates in UTC avoids carrying a DST-adjusted hour into the next date.
  // Two weeks covers a weekly slot even when one occurrence falls in a DST gap.
  for (let offset = 0; offset <= 14; offset++) {
    const date = DateTime.toPartsUtc(DateTime.add(day, { days: offset * direction }));
    if (rule.type === "weekly" && !rule.weekdays.includes(date.weekDay)) continue;
    const candidate = DateTime.makeZonedUnsafe(
      { year: date.year, month: date.month, day: date.day, hour, minute },
      { timeZone: rule.timeZone, adjustForTimeZone: true, disambiguation: "earlier" },
    );
    const actual = DateTime.toParts(candidate);
    // Gaps have no matching wall-clock time. Folds always select the first occurrence.
    if (
      actual.year !== date.year ||
      actual.month !== date.month ||
      actual.day !== date.day ||
      actual.hour !== hour ||
      actual.minute !== minute
    )
      continue;
    const epoch = DateTime.toEpochMillis(candidate);
    if (direction === 1 ? epoch > cursor : epoch <= cursor) return epoch;
  }
  return null;
}
