import type { JsonObject } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import { scheduleToolParameters } from "@eta/core/service/schedules/extension";
import { ScheduleChangeSchema } from "@eta/core/shared/schedules";

const tool = { name: "schedule", description: "Schedule", parameters: scheduleToolParameters };
const decode = Schema.decodeUnknownSync(ScheduleChangeSchema, { onExcessProperty: "error" });

const cases: Array<{ rule: JsonObject; valid: boolean }> = [
  { rule: { type: "once", at: 0 }, valid: true },
  { rule: { type: "once", at: -1 }, valid: false },
  { rule: { type: "once", at: 8_640_000_000_000_001 }, valid: false },
  { rule: { type: "interval", everyMs: 300_000, anchorAt: 0 }, valid: true },
  { rule: { type: "interval", everyMs: 299_999, anchorAt: 0 }, valid: false },
  { rule: { type: "interval", everyMs: 300_000.5, anchorAt: 0 }, valid: false },
  { rule: { type: "interval", everyMs: 8_640_000_000_000_000, anchorAt: 0 }, valid: true },
  { rule: { type: "interval", everyMs: 8_640_000_000_000_001, anchorAt: 0 }, valid: false },
  { rule: { type: "daily", time: "23:59", timeZone: "America/New_York" }, valid: true },
  { rule: { type: "daily", time: "24:00", timeZone: "UTC" }, valid: false },
  { rule: { type: "daily", time: "09:00", timeZone: "" }, valid: false },
  { rule: { type: "weekly", time: "09:00", timeZone: "UTC", weekdays: [0, 6] }, valid: true },
  { rule: { type: "weekly", time: "09:00", timeZone: "UTC", weekdays: [] }, valid: false },
  { rule: { type: "weekly", time: "09:00", timeZone: "UTC", weekdays: [1, 1] }, valid: false },
  { rule: { type: "weekly", time: "09:00", timeZone: "UTC", weekdays: [7] }, valid: false },
  { rule: { type: "once", at: 0, unknown: true }, valid: false },
];

test.each(cases)("tool and service agree on schedule rule $rule", ({ rule, valid }) => {
  for (const action of ["create", "update"] as const) {
    const args: JsonObject =
      action === "create"
        ? { action, name: "Review", prompt: "Review repository", rule }
        : { action, scheduleId: "schedule", expectedRevision: 1, patch: { rule } };
    const validate = () =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call",
        name: "schedule",
        arguments: args,
      });
    if (valid) {
      expect(validate).not.toThrow();
      expect(() => decode(args)).not.toThrow();
    } else {
      expect(validate).toThrow();
      expect(() => decode(args)).toThrow();
    }
  }
});

test("the shared decoder retains semantic IANA zone validation beyond JSON Schema", () => {
  const args = {
    action: "create",
    name: "Review",
    prompt: "Review",
    rule: { type: "daily", time: "09:00", timeZone: "Invalid/Zone" },
  };
  expect(() =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "call",
      name: "schedule",
      arguments: args,
    }),
  ).not.toThrow();
  expect(() => decode(args)).toThrow();
});
