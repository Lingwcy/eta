import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { AppPathsService } from "@eta/core/platform/app-paths";
import {
  ScheduleStoreService,
  emptyScheduleStore,
  decodeScheduleStore,
} from "@eta/core/service/schedules/store";
import { trimScheduleHistory } from "@eta/core/service/schedules/history";
import {
  scheduleDraft,
  writeScheduleChange,
  runScheduleNow,
  proposeScheduleChange,
  decideScheduleProposal,
} from "@eta/core/service/schedules/management";
import { discoverScheduleOccurrences } from "@eta/core/service/schedules/occurrences";
import { catalogFixture } from "../catalog/test-fixtures.ts";

const catalog = catalogFixture();
const change = {
  action: "create" as const,
  name: "Review",
  prompt: "Large saved prompt",
  rule: { type: "interval" as const, everyMs: 300_000, anchorAt: 0 },
};
function fixture() {
  const state = scheduleDraft(emptyScheduleStore());
  const created = writeScheduleChange(
    state,
    { threadId: "thread", requestId: "create", change },
    catalog,
    0,
  );
  return { state, scheduleId: created.scheduleId! };
}

test("terminal runs are bounded while pending, dispatching, admitted and cursor identities survive", () => {
  const { state, scheduleId } = fixture();
  for (let i = 0; i < 150; i++)
    state.occurrences[`old-${i}`] = {
      id: `old-${i}`,
      scheduleId,
      threadId: "thread",
      scheduleRevision: 1,
      scheduledAt: i * 300_000,
      detectedAt: i * 300_000,
      source: "automatic",
      name: "Review",
      prompt: "Original content",
      rule: change.rule,
      requestId: `delivery-${i}`,
      state: "skipped",
      finishedAt: i * 300_000,
    };
  const example = state.occurrences["old-0"];
  state.occurrences.pending = {
    ...example,
    id: "pending",
    requestId: "pending",
    source: "manual",
    state: "pending",
  };
  state.occurrences.unknown = {
    ...example,
    id: "unknown",
    requestId: "unknown",
    state: "dispatching",
  };
  state.occurrences.running = {
    ...example,
    id: "running",
    requestId: "running",
    state: "admitted",
    operationId: "op",
  };
  state.schedules[scheduleId] = {
    ...state.schedules[scheduleId],
    consumedThrough: 150 * 300_000,
    nextRunAt: 151 * 300_000,
  };
  const trimmed = scheduleDraft(trimScheduleHistory(state));
  expect(Object.values(trimmed.occurrences).filter((run) => run.state === "skipped")).toHaveLength(
    100,
  );
  expect(trimmed.occurrences["old-0"]).toBeUndefined();
  expect(trimmed.occurrences.pending).toEqual(state.occurrences.pending);
  expect(trimmed.occurrences.unknown).toEqual(state.occurrences.unknown);
  expect(trimmed.occurrences.running).toEqual(state.occurrences.running);
  expect(trimmed.schedules[scheduleId]).toEqual(state.schedules[scheduleId]);
  delete trimmed.occurrences.unknown;
  delete trimmed.occurrences.pending;
  discoverScheduleOccurrences(trimmed, "thread", 100 * 300_000);
  expect(trimmed.schedules[scheduleId].consumedThrough).toBe(150 * 300_000);
  decodeScheduleStore(trimmed);
});

test("manual request replay survives its history eviction without making a second occurrence", () => {
  const { state, scheduleId } = fixture();
  const input = { threadId: "thread", scheduleId, expectedRevision: 1, requestId: "manual" };
  const request = runScheduleNow(state, input, catalog, 1);
  const original = state.occurrences[request.occurrenceId!];
  state.occurrences[original.id] = { ...original, state: "cancelled", finishedAt: 2 };
  for (let i = 0; i < 100; i++)
    state.occurrences[`new-${i}`] = {
      ...original,
      id: `new-${i}`,
      requestId: `new-${i}`,
      source: "automatic",
      state: "skipped",
      scheduledAt: i + 10,
      finishedAt: i + 10,
    };
  const trimmed = scheduleDraft(trimScheduleHistory(state));
  expect(trimmed.occurrences[original.id]).toBeUndefined();
  const size = Object.keys(trimmed.occurrences).length;
  expect(runScheduleNow(trimmed, input, catalog, 1_000_000)).toEqual(request);
  expect(Object.keys(trimmed.occurrences)).toHaveLength(size);
  decodeScheduleStore(trimmed);
});

test("terminal proposal pruning retains pending proposals and compact decision replay receipts", () => {
  const { state } = fixture();
  let firstInput!: { proposalId: string; contentFingerprint: string; requestId: string };
  let firstResult;
  for (let i = 0; i < 205; i++) {
    const proposed = proposeScheduleChange(
      state,
      { threadId: "thread", requestId: `propose-${i}`, sourceIdentity: `root:call-${i}`, change },
      catalog,
      i,
    );
    const proposal = state.proposals[proposed.proposalId!];
    const input = {
      proposalId: proposal.id,
      contentFingerprint: proposal.contentFingerprint,
      requestId: `reject-${i}`,
    };
    const result = decideScheduleProposal(state, input, false, catalog, i + 1);
    if (i === 0) {
      firstInput = input;
      firstResult = result;
    }
  }
  const pending = proposeScheduleChange(
    state,
    { threadId: "thread", requestId: "pending", sourceIdentity: "root:pending", change },
    catalog,
    300,
  );
  state.requests.unsettled = {
    requestId: "unsettled",
    threadId: "thread",
    fingerprint: "pending",
    state: "pending",
    createdAt: 400,
    change,
  };
  const trimmed = scheduleDraft(trimScheduleHistory(state));
  expect(Object.keys(trimmed.proposals)).toHaveLength(201);
  expect(trimmed.proposals[firstInput.proposalId]).toBeUndefined();
  expect(trimmed.proposals[pending.proposalId!].state).toBe("pending");
  expect(trimmed.requests.unsettled.change).toEqual(change);
  expect(trimmed.requests.create.change).toBeUndefined();
  expect(decideScheduleProposal(trimmed, firstInput, false, catalog, 500)).toEqual(firstResult);
  decodeScheduleStore(trimmed);
});

test("store applies the host-wide terminal cap atomically across many schedules and reopens it", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-schedule-history-"));
  const open = () =>
    ManagedRuntime.make(
      ScheduleStoreService.layer.pipe(Layer.provide(AppPathsService.layer(root))),
    );
  let runtime = open();
  try {
    let store = await runtime.runPromise(ScheduleStoreService);
    await runtime.runPromise(
      store.update((state) => {
        const draft = scheduleDraft(state);
        for (let i = 0; i < 12; i++) {
          const created = writeScheduleChange(
            draft,
            { threadId: "thread", requestId: `create-${i}`, change },
            catalog,
            0,
          );
          const scheduleId = created.scheduleId!;
          for (let j = 0; j < 100; j++) {
            const id = `${i}:${j}`;
            draft.occurrences[id] = {
              id,
              scheduleId,
              threadId: "thread",
              scheduleRevision: 1,
              scheduledAt: j * 300_000,
              detectedAt: j * 300_000,
              source: "automatic",
              name: "Review",
              prompt: "Original",
              rule: change.rule,
              requestId: `delivery-${id}`,
              state: "skipped",
              finishedAt: i * 100 + j,
            };
          }
        }
        return draft;
      }),
    );
    expect(Object.keys((await runtime.runPromise(store.read)).occurrences)).toHaveLength(1000);
    await runtime.dispose();
    runtime = open();
    store = await runtime.runPromise(ScheduleStoreService);
    expect(Object.keys((await runtime.runPromise(store.read)).occurrences)).toHaveLength(1000);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("compact chat origins retain stable message attribution after full run details are pruned", () => {
  const state = scheduleDraft(emptyScheduleStore());
  const created = writeScheduleChange(
    state,
    { threadId: "thread", requestId: "create", change },
    catalog,
    0,
  );
  for (let i = 0; i < 101; i++) {
    const id = `run-${i}`;
    state.occurrences[id] = {
      id,
      scheduleId: created.scheduleId!,
      threadId: "thread",
      scheduleRevision: 1,
      scheduledAt: i * 300000,
      detectedAt: i * 300000,
      source: "automatic",
      name: "Saved plan name",
      prompt: "Private execution content",
      rule: change.rule,
      requestId: `delivery-${i}`,
      operationId: String(i + 1),
      inputEntryId: `${i + 100}:0`,
      state: "succeeded",
      finishedAt: i * 300000 + 1,
    };
  }
  const trimmed = trimScheduleHistory(state);
  expect(trimmed.occurrences["run-0"]).toBeUndefined();
  expect(trimmed.messageOrigins?.["run-0"]).toMatchObject({
    inputEntryId: "100:0",
    name: "Saved plan name",
    scheduledAt: 0,
    requestId: "delivery-0",
  });
  expect(JSON.stringify(trimmed.messageOrigins)).not.toContain("Private execution content");
  decodeScheduleStore(trimmed);
  expect(trimScheduleHistory(trimmed).messageOrigins?.["run-0"]).toEqual(
    trimmed.messageOrigins?.["run-0"],
  );
});
