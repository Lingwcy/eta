import { expect, test } from "vite-plus/test";
import { emptyScheduleStore, decodeScheduleStore } from "@eta/core/service/schedules/store";
import {
  scheduleDraft,
  writeScheduleChange,
  runScheduleNow,
} from "@eta/core/service/schedules/management";
import {
  discoverScheduleOccurrences,
  nextPendingOccurrence,
  finishOccurrence,
  pendingOccurrenceReason,
} from "@eta/core/service/schedules/occurrences";
import { catalogFixture } from "../catalog/test-fixtures.ts";

function fixture(once = false) {
  const state = scheduleDraft(emptyScheduleStore());
  const created = writeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "create",
      change: {
        action: "create",
        name: "Review",
        prompt: "Frozen prompt",
        rule: once
          ? { type: "once", at: 300_000 }
          : { type: "interval", everyMs: 300_000, anchorAt: 0 },
      },
    },
    catalogFixture(),
    0,
  );
  return { state, scheduleId: created.scheduleId! };
}

test("long downtime coalesces the latest due slot rather than every missed period", () => {
  const { state, scheduleId } = fixture();
  discoverScheduleOccurrences(state, "thread", 3_100_000);
  const pending = nextPendingOccurrence(state, "thread")!;
  expect(pending.scheduledAt).toBe(3_000_000);
  expect(state.schedules[scheduleId].nextRunAt).toBe(3_300_000);
  expect(state.schedules[scheduleId].revision).toBe(1);
  expect(Object.keys(state.occurrences)).toHaveLength(1);
  decodeScheduleStore(state);
});

test("busy pending slots are superseded with frozen history and independent identities", () => {
  const { state } = fixture();
  discoverScheduleOccurrences(state, "thread", 300_000);
  const oldest = nextPendingOccurrence(state, "thread")!;
  discoverScheduleOccurrences(state, "thread", 1_100_000);
  const latest = nextPendingOccurrence(state, "thread")!;
  expect(state.occurrences[oldest.id].state).toBe("skipped");
  expect(state.occurrences[oldest.id].scheduledAt).toBe(300_000);
  expect(state.occurrences[oldest.id].reason).toBe("superseded");
  expect(latest.scheduledAt).toBe(900_000);
  expect(latest.requestId).not.toBe(oldest.requestId);
  expect(latest.supersededFrom).toBe(300_000);
  decodeScheduleStore(state);
});

test("dispatching receipts cannot be merged, expired, cancelled or retried before reconciliation", () => {
  const { state, scheduleId } = fixture();
  discoverScheduleOccurrences(state, "thread", 300_000);
  const pending = nextPendingOccurrence(state, "thread")!;
  state.occurrences[pending.id] = { ...pending, state: "dispatching" };
  discoverScheduleOccurrences(state, "thread", 100_000_000);
  expect(Object.keys(state.occurrences)).toHaveLength(1);
  expect(state.occurrences[pending.id].state).toBe("dispatching");
  expect(state.schedules[scheduleId].nextRunAt).toBe(600_000);
  expect(nextPendingOccurrence(state, "thread")).toBeUndefined();
});

test("clock rollback and trimmed terminal history never regenerate a consumed slot", () => {
  const { state, scheduleId } = fixture();
  discoverScheduleOccurrences(state, "thread", 900_000);
  const pending = nextPendingOccurrence(state, "thread")!;
  finishOccurrence(state, pending, "skipped", 900_001, "missed");
  delete state.occurrences[pending.id];
  discoverScheduleOccurrences(state, "thread", 300_000);
  discoverScheduleOccurrences(state, "thread", 900_000);
  expect(Object.keys(state.occurrences)).toHaveLength(0);
  expect(state.schedules[scheduleId].consumedThrough).toBe(900_000);
  discoverScheduleOccurrences(state, "thread", 1_200_000);
  expect(nextPendingOccurrence(state, "thread")?.scheduledAt).toBe(1_200_000);
});

test("expired one-shot is recorded as missed while recurring schedules select the newest valid slot", () => {
  const { state, scheduleId } = fixture(true);
  discoverScheduleOccurrences(state, "thread", 86_700_001);
  expect(Object.values(state.occurrences)[0].reason).toBe("missed");
  expect(state.schedules[scheduleId].state).toBe("completed");
  const recurring = fixture();
  discoverScheduleOccurrences(recurring.state, "thread", 86_700_001);
  expect(nextPendingOccurrence(recurring.state, "thread")?.scheduledAt).toBe(86_700_000);
});

test("manual runs do not merge and share the original waiting window", () => {
  const { state, scheduleId } = fixture();
  runScheduleNow(
    state,
    { threadId: "thread", scheduleId, expectedRevision: 1, requestId: "manual" },
    catalogFixture(),
    10,
  );
  const manual = nextPendingOccurrence(state, "thread")!;
  discoverScheduleOccurrences(state, "thread", 1_000_000);
  expect(state.occurrences[manual.id].state).toBe("pending");
  expect(nextPendingOccurrence(state, "thread")?.id).toBe(manual.id);
  expect(pendingOccurrenceReason(state, manual, 86_400_011)).toBe("missed");
  expect(state.schedules[scheduleId].nextRunAt).toBe(1_200_000);
});

test("management intentions prevent discovery and final selection of old pending snapshots", () => {
  const { state, scheduleId } = fixture();
  discoverScheduleOccurrences(state, "thread", 300_000);
  state.requests.pause = {
    requestId: "pause",
    threadId: "thread",
    fingerprint: "pause",
    state: "pending",
    createdAt: 400_000,
    change: { action: "pause", scheduleId, expectedRevision: 1 },
  };
  discoverScheduleOccurrences(state, "thread", 1_000_000);
  expect(Object.keys(state.occurrences)).toHaveLength(1);
  expect(nextPendingOccurrence(state, "thread")).toBeUndefined();
});
