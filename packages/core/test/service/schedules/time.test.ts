import { DateTime, Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { ScheduleRuleSchema } from "@eta/core/shared/schedules";
import { latestScheduleSlot, nextScheduleSlot } from "@eta/core/service/schedules/time";

const epoch = (text: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(text));
const decode = Schema.decodeUnknownSync(ScheduleRuleSchema, { onExcessProperty: "error" });

test("one-shot and anchored intervals use strict future slots and inclusive due slots", () => {
  const once = decode({ type: "once", at: 600_000 });
  expect(nextScheduleSlot(once, 599_999)).toBe(600_000);
  expect(nextScheduleSlot(once, 600_000)).toBeNull();
  expect(latestScheduleSlot(once, 600_000)).toBe(600_000);
  const interval = decode({ type: "interval", everyMs: 300_000, anchorAt: 600_000 });
  expect(nextScheduleSlot(interval, 0)).toBe(600_000);
  expect(latestScheduleSlot(interval, 0)).toBeNull();
  expect(nextScheduleSlot(interval, 600_000)).toBe(900_000);
  expect(latestScheduleSlot(interval, 3_100_000)).toBe(3_000_000);
  expect(nextScheduleSlot(interval, 3_100_000)).toBe(3_300_000);
});

test("daily times retain their IANA wall clock across daylight saving", () => {
  const daily = decode({ type: "daily", time: "08:30", timeZone: "America/New_York" });
  expect(nextScheduleSlot(daily, epoch("2026-03-07T14:00:00Z"))).toBe(
    epoch("2026-03-08T12:30:00Z"),
  );
  expect(latestScheduleSlot(daily, epoch("2026-03-08T12:29:00Z"))).toBe(
    epoch("2026-03-07T13:30:00Z"),
  );
});

test("DST gaps skip the date and folds execute only the first occurrence", () => {
  const gap = decode({ type: "daily", time: "02:30", timeZone: "America/New_York" });
  expect(nextScheduleSlot(gap, epoch("2026-03-07T08:00:00Z"))).toBe(epoch("2026-03-09T06:30:00Z"));
  expect(latestScheduleSlot(gap, epoch("2026-03-08T08:00:00Z"))).toBe(
    epoch("2026-03-07T07:30:00Z"),
  );
  const fold = decode({ type: "daily", time: "01:30", timeZone: "America/New_York" });
  expect(nextScheduleSlot(fold, epoch("2026-11-01T00:00:00Z"))).toBe(epoch("2026-11-01T05:30:00Z"));
  expect(nextScheduleSlot(fold, epoch("2026-11-01T05:30:00Z"))).toBe(epoch("2026-11-02T06:30:00Z"));
  expect(latestScheduleSlot(fold, epoch("2026-11-01T06:45:00Z"))).toBe(
    epoch("2026-11-01T05:30:00Z"),
  );
});

test("weekly rules skip a missing Sunday time and handle non-hour offsets", () => {
  const weekly = decode({
    type: "weekly",
    weekdays: [0],
    time: "02:30",
    timeZone: "America/New_York",
  });
  expect(nextScheduleSlot(weekly, epoch("2026-03-01T08:00:00Z"))).toBe(
    epoch("2026-03-15T06:30:00Z"),
  );
  const daily = decode({ type: "daily", time: "08:30", timeZone: "Asia/Kathmandu" });
  expect(nextScheduleSlot(daily, epoch("2026-10-13T00:00:00Z"))).toBe(
    epoch("2026-10-13T02:45:00Z"),
  );
});

test.each([
  { type: "interval", everyMs: 299_999, anchorAt: 0 },
  { type: "interval", everyMs: 300_000.5, anchorAt: 0 },
  { type: "once", at: -1 },
  { type: "once", at: Infinity },
  { type: "daily", time: "24:00", timeZone: "UTC" },
  { type: "daily", time: "8:30", timeZone: "UTC" },
  { type: "daily", time: "08:30", timeZone: "Invalid/Zone" },
  { type: "weekly", weekdays: [], time: "08:30", timeZone: "UTC" },
  { type: "weekly", weekdays: [1, 1], time: "08:30", timeZone: "UTC" },
  { type: "weekly", weekdays: [7], time: "08:30", timeZone: "UTC" },
])("rejects ambiguous or invalid rule inputs %j", (input) => {
  expect(() => decode(input)).toThrow();
});
