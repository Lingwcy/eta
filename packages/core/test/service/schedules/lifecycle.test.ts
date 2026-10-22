import { expect, test } from "vite-plus/test";
import {
  finishScheduleLifecycle,
  reconcileScheduleLifecycles,
} from "@eta/core/service/schedules/lifecycle";
import { scheduleDraft, writeScheduleChange } from "@eta/core/service/schedules/management";
import { decodeScheduleStore, emptyScheduleStore } from "@eta/core/service/schedules/store";
import { catalogFixture } from "../catalog/test-fixtures.ts";

function fixture() {
  const catalog = catalogFixture();
  const state = scheduleDraft(emptyScheduleStore());
  const request = writeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "create",
      change: {
        action: "create",
        name: "Review",
        prompt: "Review",
        rule: { type: "interval", everyMs: 300_000, anchorAt: 0 },
      },
    },
    catalog,
    0,
  );
  state.requests.archive = {
    requestId: "archive",
    threadId: "thread",
    fingerprint: "archive",
    state: "pending",
    createdAt: 1,
  };
  state.lifecycleIntents.archive = {
    requestId: "archive",
    threadId: "thread",
    action: "archive",
    phase: "prepared",
    createdAt: 1,
  };
  return { catalog, state, scheduleId: request.scheduleId! };
}

test.each(["toString", "constructor", "__proto__"])(
  "archive rejects pending request %s unless it owns a lifecycle intent",
  (requestId) => {
    const { state } = fixture();
    state.requests = {
      ...state.requests,
      [requestId]: {
        requestId,
        threadId: "thread",
        fingerprint: "pending-user-request",
        state: "pending",
        createdAt: 2,
      },
    };
    finishScheduleLifecycle(state, "thread", "archive", 3);
    expect(state.requests[requestId]).toMatchObject({ state: "rejected", reason: "archive" });
    expect(state.requests.archive.state).toBe("pending");
    decodeScheduleStore(state);
  },
);

test("crash after intent but before Catalog commit rolls back without pausing schedules", () => {
  const { catalog, state, scheduleId } = fixture();
  const reopened = scheduleDraft(decodeScheduleStore(JSON.parse(JSON.stringify(state))));
  reconcileScheduleLifecycles(reopened, catalog, 10);
  expect(reopened.schedules[scheduleId].state).toBe("active");
  expect(reopened.requests.archive.state).toBe("rejected");
  expect(reopened.lifecycleIntents).toEqual({});
  decodeScheduleStore(reopened);
});

test("crash after Catalog commit repairs the schedule before unarchive and remains paused", () => {
  const { catalog, state, scheduleId } = fixture();
  const archived = {
    ...catalog,
    threads: catalog.threads.map((thread) => ({ ...thread, archivedAt: 2 })),
  };
  const reopened = scheduleDraft(decodeScheduleStore(JSON.parse(JSON.stringify(state))));
  reconcileScheduleLifecycles(reopened, archived, 10);
  expect(reopened.requests.archive.state).toBe("applied");
  expect(reopened.schedules[scheduleId].state).toBe("paused");
  expect(reopened.schedules[scheduleId].nextRunAt).toBeNull();
  expect(reopened.lifecycleIntents).toEqual({});
  const revision = reopened.schedules[scheduleId].revision;
  reconcileScheduleLifecycles(reopened, catalog, 11);
  expect(reopened.schedules[scheduleId].state).toBe("paused");
  expect(reopened.schedules[scheduleId].revision).toBe(revision);
  decodeScheduleStore(reopened);
});

test("orphan schedule repair creates tombstones and preserves admitted execution", () => {
  const { catalog, state, scheduleId } = fixture();
  state.occurrences.running = {
    id: "running",
    scheduleId,
    threadId: "thread",
    scheduleRevision: 1,
    scheduledAt: 300_000,
    detectedAt: 300_000,
    source: "automatic",
    name: "Review",
    prompt: "Original",
    rule: state.schedules[scheduleId].rule,
    requestId: "delivery",
    state: "admitted",
    operationId: "op",
  };
  const { operationId: _operationId, ...waiting } = state.occurrences.running;
  state.occurrences.waiting = {
    ...waiting,
    id: "waiting",
    requestId: "manual-delivery",
    source: "manual",
    state: "pending",
  };
  reconcileScheduleLifecycles(state, { ...catalog, threads: [] }, 400_000);
  expect(state.schedules[scheduleId].deletedAt).toBe(400_000);
  expect(state.occurrences.running.state).toBe("admitted");
  expect(state.occurrences.waiting.state).toBe("cancelled");
  const revision = state.schedules[scheduleId].revision;
  reconcileScheduleLifecycles(state, { ...catalog, threads: [] }, 500_000);
  expect(state.schedules[scheduleId].revision).toBe(revision);
  decodeScheduleStore(state);
});

test("unresolved admission blocks lifecycle repair instead of assuming a missing receipt", () => {
  const { catalog, state, scheduleId } = fixture();
  state.occurrences.uncertain = {
    id: "uncertain",
    scheduleId,
    threadId: "thread",
    scheduleRevision: 1,
    scheduledAt: 300_000,
    detectedAt: 300_000,
    source: "automatic",
    name: "Review",
    prompt: "Review",
    rule: state.schedules[scheduleId].rule,
    requestId: "delivery",
    state: "dispatching",
  };
  reconcileScheduleLifecycles(state, { ...catalog, threads: [] }, 400_000);
  expect(state.lifecycleIntents.archive).toBeDefined();
  expect(state.requests.archive.state).toBe("pending");
  expect(state.schedules[scheduleId].state).toBe("active");
  expect(state.occurrences.uncertain.state).toBe("dispatching");
  decodeScheduleStore(state);
});

test("archival preserves completed one-shot status while cancelling queued manual occurrences", () => {
  const { state, scheduleId } = fixture();
  state.schedules[scheduleId] = {
    ...state.schedules[scheduleId],
    state: "completed",
    nextRunAt: null,
  };
  finishScheduleLifecycle(state, "thread", "archive", 100);
  expect(state.schedules[scheduleId].state).toBe("completed");
  expect(state.schedules[scheduleId].revision).toBe(1);
});
