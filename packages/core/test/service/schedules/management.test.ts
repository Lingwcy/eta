import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { expect, test } from "vite-plus/test";
import { AppPathsService } from "@eta/core/platform/app-paths";
import {
  emptyScheduleStore,
  decodeScheduleStore,
  ScheduleStoreService,
} from "@eta/core/service/schedules/store";
import {
  scheduleDraft,
  writeScheduleChange,
  proposeScheduleChange,
  decideScheduleProposal,
  settleScheduleRequests,
} from "@eta/core/service/schedules/management";
import type { ScheduleChange, ScheduleOccurrence } from "@eta/core/shared/schedules";
import { catalogFixture } from "../catalog/test-fixtures.ts";

const catalog = catalogFixture();
const create = {
  action: "create",
  name: "Review",
  prompt: "Review repository",
  rule: { type: "interval", everyMs: 300_000, anchorAt: 0 },
} satisfies ScheduleChange;
function fixture() {
  const state = scheduleDraft(emptyScheduleStore());
  const request = writeScheduleChange(
    state,
    { threadId: "thread", requestId: "create", change: create },
    catalog,
    10,
  );
  const scheduleId = request.scheduleId!;
  const occurrence: ScheduleOccurrence = {
    id: "run",
    scheduleId,
    threadId: "thread",
    scheduleRevision: 1,
    scheduledAt: 300_000,
    detectedAt: 300_000,
    source: "automatic",
    name: "Review",
    prompt: "Frozen prompt",
    rule: create.rule,
    requestId: "delivery",
    state: "pending",
  };
  return { state, scheduleId, occurrence };
}
function proposalFixture() {
  const state = scheduleDraft(emptyScheduleStore());
  const request = proposeScheduleChange(
    state,
    { threadId: "thread", requestId: "tool-call", sourceIdentity: "root:call", change: create },
    catalog,
    10,
  );
  const proposalId = request.proposalId!;
  const contentFingerprint = state.proposals[proposalId].contentFingerprint;
  return { state, proposalId, contentFingerprint };
}

test("write replay precedes revision checks and conflicts never overwrite the original receipt", () => {
  const { state, scheduleId } = fixture();
  const input = {
    threadId: "thread",
    requestId: "pause",
    change: { action: "pause" as const, scheduleId, expectedRevision: 1 },
  };
  const result = writeScheduleChange(state, input, catalog, 20);
  expect(result.state).toBe("applied");
  expect(writeScheduleChange(state, input, catalog, 30)).toEqual(result);
  expect(state.schedules[scheduleId].revision).toBe(2);
  expect(() =>
    writeScheduleChange(
      state,
      { ...input, change: { ...input.change, action: "delete" } },
      catalog,
      40,
    ),
  ).toThrow();
  expect(state.requests.pause).toEqual(result);
  expect(writeScheduleChange(state, { ...input, requestId: "stale" }, catalog, 40).state).toBe(
    "rejected",
  );
  decodeScheduleStore(state);
});

test("editing cancels only pending snapshots and invalidates old proposals", () => {
  const { state, scheduleId, occurrence } = fixture();
  state.schedules[scheduleId] = { ...state.schedules[scheduleId], blockedReason: "busy" };
  state.occurrences.run = occurrence;
  state.occurrences.started = {
    ...occurrence,
    id: "started",
    requestId: "started-delivery",
    state: "admitted",
    operationId: "op",
  };
  const proposal = proposeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "proposal",
      sourceIdentity: "root:call",
      change: { action: "pause", scheduleId, expectedRevision: 1 },
    },
    catalog,
    100,
  );
  writeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "edit",
      change: {
        action: "update",
        scheduleId,
        expectedRevision: 1,
        patch: { prompt: "New prompt" },
      },
    },
    catalog,
    650_000,
  );
  expect(state.schedules[scheduleId].nextRunAt).toBe(900_000);
  expect(state.schedules[scheduleId].prompt).toBe("New prompt");
  expect(state.schedules[scheduleId].blockedReason).toBeUndefined();
  expect(state.occurrences.run.state).toBe("cancelled");
  expect(state.occurrences.run.prompt).toBe("Frozen prompt");
  expect(state.occurrences.started.state).toBe("admitted");
  expect(state.proposals[proposal.proposalId!].state).toBe("invalidated");
  decodeScheduleStore(state);
});

test("pause/resume skip missed periods and delete keeps admitted results and tombstones", () => {
  const { state, scheduleId, occurrence } = fixture();
  state.occurrences.run = { ...occurrence, state: "admitted", operationId: "op" };
  writeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "pause",
      change: { action: "pause", scheduleId, expectedRevision: 1 },
    },
    catalog,
    100,
  );
  expect(state.schedules[scheduleId].nextRunAt).toBeNull();
  writeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "resume",
      change: { action: "resume", scheduleId, expectedRevision: 2 },
    },
    catalog,
    1_000_000,
  );
  expect(state.schedules[scheduleId].nextRunAt).toBe(1_200_000);
  writeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "delete",
      change: { action: "delete", scheduleId, expectedRevision: 3 },
    },
    catalog,
    1_000_001,
  );
  expect(state.schedules[scheduleId].deletedAt).toBe(1_000_001);
  expect(state.occurrences.run.operationId).toBe("op");
  expect(catalog.threads).toHaveLength(1);
  decodeScheduleStore(state);
});

test("admission uncertainty persists a pending management request until the receipt converges", () => {
  const { state, scheduleId, occurrence } = fixture();
  state.occurrences.run = { ...occurrence, state: "dispatching" };
  const input = {
    threadId: "thread",
    requestId: "pause",
    change: { action: "pause" as const, scheduleId, expectedRevision: 1 },
  };
  expect(writeScheduleChange(state, input, catalog, 400_000).state).toBe("pending");
  expect(state.schedules[scheduleId].state).toBe("active");
  settleScheduleRequests(state, "thread", catalog, 400_001);
  expect(state.requests.pause.state).toBe("pending");
  // A query returning no receipt while submission is in flight must leave dispatching intact.
  const reopened = scheduleDraft(decodeScheduleStore(JSON.parse(JSON.stringify(state))));
  reopened.occurrences.run = { ...reopened.occurrences.run, state: "admitted", operationId: "op" };
  settleScheduleRequests(reopened, "thread", catalog, 400_002);
  expect(reopened.requests.pause.state).toBe("applied");
  expect(reopened.schedules[scheduleId].state).toBe("paused");
  expect(reopened.occurrences.run.state).toBe("admitted");
  expect(writeScheduleChange(reopened, input, catalog, 500_000)).toEqual(reopened.requests.pause);
  decodeScheduleStore(reopened);
});

test("proposals never activate a schedule; approval binds content and begins at the next future slot", () => {
  const { state, proposalId, contentFingerprint } = proposalFixture();
  expect(Object.keys(state.schedules)).toHaveLength(0);
  const replay = proposeScheduleChange(
    state,
    { threadId: "thread", requestId: "tool-call", sourceIdentity: "root:call", change: create },
    catalog,
    20,
  );
  expect(replay.proposalId).toBe(proposalId);
  const input = { proposalId, contentFingerprint, requestId: "approve" };
  const request = decideScheduleProposal(state, input, true, catalog, 650_000);
  expect(request.state).toBe("applied");
  expect(state.proposals[proposalId].state).toBe("approved");
  expect(state.schedules[request.scheduleId!].nextRunAt).toBe(900_000);
  expect(state.schedules[request.scheduleId!].source).toBe("agent");
  expect(decideScheduleProposal(state, input, true, catalog, 700_000)).toEqual(request);
  expect(Object.keys(state.schedules)).toHaveLength(1);
  decodeScheduleStore(state);
});

test("wrong content fingerprint leaves the real proposal available for a valid decision", () => {
  const { state, proposalId, contentFingerprint } = proposalFixture();
  expect(
    decideScheduleProposal(
      state,
      { proposalId, contentFingerprint: "wrong", requestId: "wrong" },
      true,
      catalog,
      20,
    ).state,
  ).toBe("rejected");
  expect(state.proposals[proposalId].state).toBe("pending");
  expect(
    decideScheduleProposal(
      state,
      { proposalId, contentFingerprint, requestId: "correct" },
      false,
      catalog,
      30,
    ).state,
  ).toBe("applied");
  expect(state.proposals[proposalId].state).toBe("rejected");
  expect(Object.keys(state.schedules)).toHaveLength(0);
  decodeScheduleStore(state);
});

test.each(["expired", "workspace", "archive"])(
  "approval rejects %s changes without activating content",
  (reason) => {
    const { state, proposalId, contentFingerprint } = proposalFixture();
    const changedCatalog =
      reason === "workspace"
        ? {
            ...catalog,
            threads: catalog.threads.map((thread) => ({ ...thread, workspaceId: "other" })),
            workspaces: [...catalog.workspaces, { ...catalog.workspaces[0], id: "other" }],
          }
        : reason === "archive"
          ? {
              ...catalog,
              threads: catalog.threads.map((thread) => ({ ...thread, archivedAt: 15 })),
            }
          : catalog;
    const now = reason === "expired" ? 86_400_010 : 20;
    const result = decideScheduleProposal(
      state,
      { proposalId, contentFingerprint, requestId: "approve" },
      true,
      changedCatalog,
      now,
    );
    expect(result.state).toBe("rejected");
    expect(Object.keys(state.schedules)).toHaveLength(0);
    expect(state.proposals[proposalId].state).toBe(
      reason === "expired" ? "expired" : "invalidated",
    );
    decodeScheduleStore(state);
  },
);

test("pending approval is atomic with activation after admission convergence", () => {
  const { state, scheduleId, occurrence } = fixture();
  state.occurrences.run = { ...occurrence, state: "dispatching" };
  const proposed = proposeScheduleChange(
    state,
    {
      threadId: "thread",
      requestId: "propose-pause",
      sourceIdentity: "root:call",
      change: { action: "pause", scheduleId, expectedRevision: 1 },
    },
    catalog,
    310_000,
  );
  const proposalId = proposed.proposalId!;
  const input = {
    proposalId,
    contentFingerprint: state.proposals[proposalId].contentFingerprint,
    requestId: "approve-pause",
  };
  expect(decideScheduleProposal(state, input, true, catalog, 310_001).state).toBe("pending");
  expect(state.proposals[proposalId].state).toBe("pending");
  state.occurrences.run = { ...state.occurrences.run, state: "pending" };
  settleScheduleRequests(state, "thread", catalog, 310_002);
  expect(state.proposals[proposalId].state).toBe("approved");
  expect(state.requests["approve-pause"].state).toBe("applied");
  expect(state.schedules[scheduleId].state).toBe("paused");
  expect(state.occurrences.run.state).toBe("cancelled");
  decodeScheduleStore(state);
});

test("per-thread schedule limit and stale single-shot approval are enforced", () => {
  const { state } = fixture();
  for (let i = 1; i < 20; i++)
    expect(
      writeScheduleChange(
        state,
        { threadId: "thread", requestId: `create-${i}`, change: create },
        catalog,
        10,
      ).state,
    ).toBe("applied");
  expect(
    writeScheduleChange(
      state,
      { threadId: "thread", requestId: "too-many", change: create },
      catalog,
      10,
    ).state,
  ).toBe("rejected");
  const fresh = scheduleDraft(emptyScheduleStore());
  const result = proposeScheduleChange(
    fresh,
    {
      threadId: "thread",
      requestId: "once",
      sourceIdentity: "root:call",
      change: { ...create, rule: { type: "once", at: 100 } },
    },
    catalog,
    10,
  );
  const proposal = fresh.proposals[result.proposalId!];
  expect(
    decideScheduleProposal(
      fresh,
      {
        proposalId: proposal.id,
        contentFingerprint: proposal.contentFingerprint,
        requestId: "late",
      },
      true,
      catalog,
      100,
    ).state,
  ).toBe("rejected");
  expect(Object.keys(fresh.schedules)).toHaveLength(0);
});

test("atomic approval persists through close and replay without creating another schedule", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-schedule-approval-"));
  const open = () =>
    ManagedRuntime.make(
      ScheduleStoreService.layer.pipe(Layer.provide(AppPathsService.layer(root))),
    );
  let runtime = open();
  try {
    let store = await runtime.runPromise(ScheduleStoreService);
    const proposed = await runtime.runPromise(
      store.update((state) => {
        const draft = scheduleDraft(state);
        proposeScheduleChange(
          draft,
          { threadId: "thread", requestId: "propose", sourceIdentity: "root:call", change: create },
          catalog,
          10,
        );
        return draft;
      }),
    );
    const proposal = Object.values(proposed.proposals)[0];
    const input = {
      proposalId: proposal.id,
      contentFingerprint: proposal.contentFingerprint,
      requestId: "approve",
    };
    const approved = await runtime.runPromise(
      store.update((state) => {
        const draft = scheduleDraft(state);
        decideScheduleProposal(draft, input, true, catalog, 20);
        return draft;
      }),
    );
    await runtime.dispose();
    runtime = open();
    store = await runtime.runPromise(ScheduleStoreService);
    const replayed = await runtime.runPromise(
      store.update((state) => {
        const draft = scheduleDraft(state);
        decideScheduleProposal(draft, input, true, catalog, 30);
        return draft;
      }),
    );
    expect(replayed.schedules).toEqual(approved.schedules);
    expect(replayed.requests.approve).toEqual(approved.requests.approve);
    expect(Object.keys(replayed.schedules)).toHaveLength(1);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
