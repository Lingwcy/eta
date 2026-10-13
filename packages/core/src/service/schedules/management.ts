import { createHash, randomUUID } from "node:crypto";
import { Predicate, Schema } from "effect";
import type { CatalogState } from "../../shared/catalog.ts";
import {
  DEFAULT_MISSED_WINDOW_MS,
  DEFAULT_PROPOSAL_TTL_MS,
  MAX_HOST_SCHEDULES,
  MAX_THREAD_SCHEDULES,
  ScheduleChangeSchema,
  type ScheduleChange,
  type ScheduleProposal,
  type ScheduleRequest,
  type ScheduleStoreState,
} from "../../shared/schedules.ts";
import { CoreError } from "../errors.ts";
import { nextScheduleSlot } from "./time.ts";

/** Each transaction edits a private draft; persisted snapshots remain immutable. */
export function scheduleDraft(state: ScheduleStoreState) {
  return {
    ...state,
    schedules: { ...state.schedules },
    occurrences: { ...state.occurrences },
    proposals: { ...state.proposals },
    requests: { ...state.requests },
    lifecycleIntents: { ...state.lifecycleIntents },
  };
}
export type ScheduleDraft = ReturnType<typeof scheduleDraft>;

export const ScheduleWriteInputSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  change: ScheduleChangeSchema,
});
export type ScheduleWriteInput = typeof ScheduleWriteInputSchema.Type;
export const ScheduleProposeInputSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
  sourceIdentity: Schema.NonEmptyString,
  change: ScheduleChangeSchema,
});
export type ScheduleProposeInput = typeof ScheduleProposeInputSchema.Type;
export const ScheduleDecisionInputSchema = Schema.Struct({
  proposalId: Schema.NonEmptyString,
  contentFingerprint: Schema.NonEmptyString,
  requestId: Schema.NonEmptyString,
});
export type ScheduleDecisionInput = typeof ScheduleDecisionInputSchema.Type;

/** Fingerprints are opaque transport values; object field order never changes request identity. */
export function scheduleFingerprint(input: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(input, (_key, value: unknown) =>
        Predicate.isObject(value) && !Array.isArray(value)
          ? Object.fromEntries(
              Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
            )
          : value,
      ),
    )
    .digest("hex");
}

function compactScheduleRequest(request: ScheduleRequest): ScheduleRequest {
  if (request.state === "pending") return request;
  const { change: _change, ...receipt } = request;
  return receipt;
}

function invalid(message: string): never {
  throw new CoreError({ code: "InvalidInput", message });
}
function replay(state: ScheduleDraft, requestId: string, fingerprint: string) {
  const existing = state.requests[requestId];
  if (existing && existing.fingerprint !== fingerprint) invalid("请求身份已用于不同的定时任务参数");
  return existing;
}
function threadWorkspace(catalog: CatalogState, threadId: string) {
  const thread = catalog.threads.find((thread) => thread.id === threadId);
  if (!thread || thread.archivedAt !== undefined) invalid("会话已归档或不存在");
  const workspace = catalog.workspaces.find((workspace) => workspace.id === thread.workspaceId);
  if (!workspace) invalid("会话执行工作区不可用");
  return workspace.id;
}
function checkChange(state: ScheduleDraft, threadId: string, change: ScheduleChange, now: number) {
  if (Object.values(state.lifecycleIntents).some((intent) => intent.threadId === threadId))
    invalid("会话生命周期变更正在处理");
  if (change.action === "create") {
    const schedules = Object.values(state.schedules).filter(
      (schedule) => schedule.deletedAt === undefined,
    );
    if (
      schedules.length >= MAX_HOST_SCHEDULES ||
      schedules.filter((schedule) => schedule.threadId === threadId).length >= MAX_THREAD_SCHEDULES
    )
      invalid("定时任务数量已达上限");
    if (nextScheduleSlot(change.rule, now) === null) invalid("执行时间必须在未来");
    return;
  }
  const schedule = state.schedules[change.scheduleId];
  if (!schedule || schedule.deletedAt !== undefined || schedule.threadId !== threadId)
    invalid("定时任务不存在于当前会话");
  if (schedule.revision !== change.expectedRevision) invalid("定时任务已变更，请重新加载后重试");
  if (change.action === "update") {
    if (Object.keys(change.patch).length === 0) invalid("请提供需要修改的字段");
    if (nextScheduleSlot(change.patch.rule ?? schedule.rule, now) === null)
      invalid("执行时间必须在未来");
  }
  if (change.action === "resume" && nextScheduleSlot(schedule.rule, now) === null)
    invalid("一次性任务已过期，请重新设置执行时间或立即运行");
}

function applyChange(
  state: ScheduleDraft,
  request: ScheduleRequest,
  now: number,
  source: "user" | "agent",
) {
  const change = request.change;
  if (!change) invalid("管理请求缺少计划变更");
  checkChange(state, request.threadId, change, now);
  let scheduleId: string;
  if (change.action === "create") {
    scheduleId = randomUUID();
    state.schedules[scheduleId] = {
      id: scheduleId,
      threadId: request.threadId,
      name: change.name,
      prompt: change.prompt,
      rule: change.rule,
      state: "active",
      nextRunAt: nextScheduleSlot(change.rule, now),
      consumedThrough: null,
      revision: 1,
      missedWindowMs: DEFAULT_MISSED_WINDOW_MS,
      source,
      createdAt: now,
      updatedAt: now,
    };
  } else {
    scheduleId = change.scheduleId;
    const current = state.schedules[scheduleId];
    const patch = change.action === "update" ? change.patch : {};
    const rule = patch.rule ?? current.rule;
    const status =
      change.action === "pause" || change.action === "delete"
        ? "paused"
        : change.action === "resume"
          ? "active"
          : current.state;
    state.schedules[scheduleId] = {
      ...current,
      ...patch,
      rule,
      state: status,
      revision: current.revision + 1,
      updatedAt: now,
      consumedThrough: null,
      nextRunAt: status === "active" ? nextScheduleSlot(rule, now) : null,
      ...(change.action === "delete" ? { deletedAt: now } : {}),
    };
    for (const [id, occurrence] of Object.entries(state.occurrences)) {
      if (occurrence.scheduleId === scheduleId && occurrence.state === "pending")
        state.occurrences[id] = {
          ...occurrence,
          state: "cancelled",
          reason: change.action,
          finishedAt: now,
        };
    }
    for (const [id, proposal] of Object.entries(state.proposals)) {
      if (
        proposal.state === "pending" &&
        proposal.change.action !== "create" &&
        proposal.change.scheduleId === scheduleId &&
        id !== request.proposalId
      )
        state.proposals[id] = { ...proposal, state: "invalidated", reason: "计划已变更" };
    }
  }
  return { ...request, state: "applied" as const, scheduleId, finishedAt: now };
}

/** Called inside one store transaction. Admission uncertainty leaves a durable pending intention. */
export function writeScheduleChange(
  state: ScheduleDraft,
  input: ScheduleWriteInput,
  catalog: CatalogState,
  now: number,
): ScheduleRequest {
  const fingerprint = scheduleFingerprint({ kind: "write", ...input });
  const existing = replay(state, input.requestId, fingerprint);
  if (existing) return existing;
  let request: ScheduleRequest = {
    requestId: input.requestId,
    threadId: input.threadId,
    fingerprint,
    change: input.change,
    state: "pending",
    createdAt: now,
  };
  try {
    threadWorkspace(catalog, input.threadId);
    checkChange(state, input.threadId, input.change, now);
    if (
      !Object.values(state.occurrences).some(
        (occurrence) =>
          occurrence.threadId === input.threadId && occurrence.state === "dispatching",
      ) &&
      !Object.values(state.requests).some(
        (value) => value.threadId === input.threadId && value.state === "pending",
      )
    )
      request = applyChange(state, request, now, "user");
    else request = { ...request, reason: "admissionUnknown" };
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    request = { ...request, state: "rejected", reason: error.message, finishedAt: now };
  }
  state.requests[input.requestId] = compactScheduleRequest(request);
  return state.requests[input.requestId];
}

/** Proposals freeze both content and execution workspace; they never create an active schedule. */
export function proposeScheduleChange(
  state: ScheduleDraft,
  input: ScheduleProposeInput,
  catalog: CatalogState,
  now: number,
): ScheduleRequest {
  const fingerprint = scheduleFingerprint({ kind: "proposal", ...input });
  const existing = replay(state, input.requestId, fingerprint);
  if (existing) return existing;
  let request: ScheduleRequest = {
    requestId: input.requestId,
    threadId: input.threadId,
    fingerprint,
    state: "applied",
    createdAt: now,
    finishedAt: now,
  };
  try {
    const workspaceId = threadWorkspace(catalog, input.threadId);
    checkChange(state, input.threadId, input.change, now);
    if (
      Object.values(state.proposals).filter(
        (proposal) => proposal.state === "pending" && proposal.expiresAt > now,
      ).length >= MAX_HOST_SCHEDULES
    )
      invalid("待确认提案数量已达上限");
    const proposalId = randomUUID();
    const contentFingerprint = scheduleFingerprint({
      threadId: input.threadId,
      workspaceId,
      change: input.change,
    });
    state.proposals[proposalId] = {
      id: proposalId,
      threadId: input.threadId,
      change: structuredClone(input.change),
      workspaceId,
      contentFingerprint,
      sourceIdentity: input.sourceIdentity,
      createdAt: now,
      expiresAt: now + DEFAULT_PROPOSAL_TTL_MS,
      state: "pending",
    };
    request = { ...request, proposalId };
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    request = { ...request, state: "rejected", reason: error.message };
  }
  state.requests[input.requestId] = compactScheduleRequest(request);
  return state.requests[input.requestId];
}

export function decideScheduleProposal(
  state: ScheduleDraft,
  input: ScheduleDecisionInput,
  approved: boolean,
  catalog: CatalogState,
  now: number,
): ScheduleRequest {
  const fingerprint = scheduleFingerprint({ kind: approved ? "approve" : "reject", ...input });
  const existing = replay(state, input.requestId, fingerprint);
  if (existing) return existing;
  const proposal = state.proposals[input.proposalId];
  if (!proposal) invalid("待确认提案不存在");
  let request: ScheduleRequest = {
    requestId: input.requestId,
    threadId: proposal.threadId,
    fingerprint,
    proposalId: proposal.id,
    state: "pending",
    createdAt: now,
    ...(approved ? { change: proposal.change } : {}),
  };
  try {
    if (proposal.contentFingerprint !== input.contentFingerprint)
      invalid("提案内容指纹不一致，请重新加载");
    if (proposal.state !== "pending" || proposal.decisionRequestId) invalid("提案已处理或正在处理");
    if (proposal.expiresAt <= now) {
      state.proposals[proposal.id] = { ...proposal, state: "expired", reason: "确认期限已过" };
      invalid("提案已过期，请重新提出");
    }
    if (!approved) {
      state.proposals[proposal.id] = {
        ...proposal,
        state: "rejected",
        decisionRequestId: input.requestId,
      };
      request = { ...request, state: "applied", finishedAt: now };
    } else {
      if (threadWorkspace(catalog, proposal.threadId) !== proposal.workspaceId)
        invalid("执行工作区已变更，请重新提出");
      checkChange(state, proposal.threadId, proposal.change, now);
      if (
        Object.values(state.occurrences).some(
          (occurrence) =>
            occurrence.threadId === proposal.threadId && occurrence.state === "dispatching",
        ) ||
        Object.values(state.requests).some(
          (value) => value.threadId === proposal.threadId && value.state === "pending",
        )
      ) {
        request = { ...request, reason: "admissionUnknown" };
        state.proposals[proposal.id] = { ...proposal, decisionRequestId: request.requestId };
      } else {
        request = applyChange(state, request, now, "agent");
        state.proposals[proposal.id] = approvedProposal(proposal, request);
      }
    }
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    request = { ...request, state: "rejected", reason: error.message, finishedAt: now };
    if (
      proposal.contentFingerprint === input.contentFingerprint &&
      approved &&
      state.proposals[proposal.id].state === "pending" &&
      !proposal.decisionRequestId
    )
      state.proposals[proposal.id] = { ...proposal, state: "invalidated", reason: error.message };
  }
  state.requests[input.requestId] = compactScheduleRequest(request);
  return state.requests[input.requestId];
}

function approvedProposal(proposal: ScheduleProposal, request: ScheduleRequest): ScheduleProposal {
  return {
    ...proposal,
    state: "approved",
    scheduleId: request.scheduleId,
    decisionRequestId: request.requestId,
  };
}

/** Only run after the host proves all in-flight admissions for the thread have ended. */
export function settleScheduleRequests(
  state: ScheduleDraft,
  threadId: string,
  catalog: CatalogState,
  now: number,
) {
  if (
    Object.values(state.occurrences).some(
      (occurrence) => occurrence.threadId === threadId && occurrence.state === "dispatching",
    )
  )
    return;
  const pending = Object.values(state.requests)
    .filter(
      (request) => request.threadId === threadId && request.state === "pending" && request.change,
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId),
    );
  for (let request of pending) {
    const proposal = request.proposalId ? state.proposals[request.proposalId] : undefined;
    try {
      const workspaceId = threadWorkspace(catalog, threadId);
      if (
        proposal &&
        (proposal.state !== "pending" ||
          proposal.expiresAt <= now ||
          proposal.workspaceId !== workspaceId ||
          proposal.decisionRequestId !== request.requestId)
      )
        invalid("提案已失效，请重新提出");
      request = applyChange(state, request, now, proposal ? "agent" : "user");
      if (proposal) state.proposals[proposal.id] = approvedProposal(proposal, request);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      request = { ...request, state: "rejected", reason: error.message, finishedAt: now };
      if (proposal)
        state.proposals[proposal.id] = { ...proposal, state: "invalidated", reason: error.message };
    }
    state.requests[request.requestId] = compactScheduleRequest(request);
  }
}

export const ScheduleRunInputSchema = Schema.Struct({
  threadId: Schema.NonEmptyString,
  scheduleId: Schema.NonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  requestId: Schema.NonEmptyString,
});
export type ScheduleRunInput = typeof ScheduleRunInputSchema.Type;

/** Manual runs have their own delivery identity and leave the automatic cursor untouched. */
export function runScheduleNow(
  state: ScheduleDraft,
  input: ScheduleRunInput,
  catalog: CatalogState,
  now: number,
): ScheduleRequest {
  const fingerprint = scheduleFingerprint({ kind: "manual", ...input });
  const existing = replay(state, input.requestId, fingerprint);
  if (existing) return existing;
  let request: ScheduleRequest = {
    requestId: input.requestId,
    threadId: input.threadId,
    fingerprint,
    state: "applied",
    createdAt: now,
    finishedAt: now,
  };
  try {
    threadWorkspace(catalog, input.threadId);
    checkChange(
      state,
      input.threadId,
      { action: "pause", scheduleId: input.scheduleId, expectedRevision: input.expectedRevision },
      now,
    );
    if (
      Object.values(state.requests).some(
        (value) => value.threadId === input.threadId && value.state === "pending",
      )
    )
      invalid("计划管理请求正在处理，请稍后重试");
    if (
      Object.values(state.occurrences).some(
        (occurrence) =>
          occurrence.scheduleId === input.scheduleId &&
          occurrence.source === "manual" &&
          ["pending", "dispatching"].includes(occurrence.state),
      )
    )
      invalid("已有立即运行请求正在等待投递");
    const schedule = state.schedules[input.scheduleId];
    const occurrenceId = randomUUID();
    state.occurrences[occurrenceId] = {
      id: occurrenceId,
      scheduleId: schedule.id,
      threadId: schedule.threadId,
      scheduleRevision: schedule.revision,
      scheduledAt: now,
      detectedAt: now,
      source: "manual",
      name: schedule.name,
      prompt: schedule.prompt,
      rule: schedule.rule,
      requestId: `schedule:manual:${input.requestId}`,
      state: "pending",
    };
    request = { ...request, scheduleId: schedule.id, occurrenceId };
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    request = { ...request, state: "rejected", reason: error.message };
  }
  state.requests[input.requestId] = compactScheduleRequest(request);
  return state.requests[input.requestId];
}
