import type { Schedule, ScheduleOccurrence } from "../../shared/schedules.ts";
import type { ScheduleDraft } from "./management.ts";
import { latestScheduleSlot, nextScheduleSlot } from "./time.ts";

const pendingManagement = (state: ScheduleDraft, threadId: string) =>
  Object.values(state.requests).some(
    (request) => request.threadId === threadId && request.state === "pending",
  ) || Object.values(state.lifecycleIntents).some((intent) => intent.threadId === threadId);

/** Discovery and coalescing run in the thread gate and one atomic store transaction. */
export function discoverScheduleOccurrences(state: ScheduleDraft, threadId: string, now: number) {
  if (pendingManagement(state, threadId)) return;
  for (const schedule of Object.values(state.schedules)) {
    if (
      schedule.threadId !== threadId ||
      schedule.deletedAt !== undefined ||
      schedule.state !== "active"
    )
      continue;
    if (schedule.nextRunAt === null || schedule.nextRunAt > now) continue;
    const queued = Object.values(state.occurrences).find(
      (occurrence) =>
        occurrence.scheduleId === schedule.id &&
        occurrence.source === "automatic" &&
        ["pending", "dispatching"].includes(occurrence.state),
    );
    if (queued?.state === "dispatching") continue;
    const slot = latestScheduleSlot(schedule.rule, now);
    if (
      slot === null ||
      slot < schedule.nextRunAt ||
      (schedule.consumedThrough !== null && slot <= schedule.consumedThrough)
    )
      continue;
    if (queued)
      state.occurrences[queued.id] = {
        ...queued,
        state: "skipped",
        reason: "superseded",
        finishedAt: now,
      };
    const requestId = `schedule:automatic:${schedule.id}:${schedule.revision}:${slot}`;
    const id = requestId;
    const expired = now - slot > schedule.missedWindowMs;
    // The consumed cursor survives terminal-history trimming and clock rollback.
    state.schedules[schedule.id] = {
      ...schedule,
      consumedThrough: slot,
      nextRunAt: nextScheduleSlot(schedule.rule, slot),
      ...(expired && schedule.rule.type === "once" ? { state: "completed" as const } : {}),
    };
    if (!state.occurrences[id])
      state.occurrences[id] = {
        id,
        scheduleId: schedule.id,
        threadId,
        scheduleRevision: schedule.revision,
        scheduledAt: slot,
        detectedAt: now,
        source: "automatic",
        name: schedule.name,
        prompt: schedule.prompt,
        rule: schedule.rule,
        requestId,
        state: expired ? "skipped" : "pending",
        ...(expired ? { reason: "missed", finishedAt: now } : {}),
        ...(queued ? { supersededFrom: queued.scheduledAt } : {}),
      };
  }
}

/** Revalidate the saved snapshot immediately before persisting a submission intention. */
export function pendingOccurrenceReason(
  state: ScheduleDraft,
  occurrence: ScheduleOccurrence,
  now: number,
): string | undefined {
  const schedule = state.schedules[occurrence.scheduleId];
  if (!schedule || schedule.deletedAt !== undefined) return "deleted";
  if (schedule.revision !== occurrence.scheduleRevision) return "revisionChanged";
  if (occurrence.source === "automatic" && schedule.state !== "active") return "paused";
  if (now - occurrence.scheduledAt > schedule.missedWindowMs) return "missed";
  return undefined;
}

export function nextPendingOccurrence(state: ScheduleDraft, threadId: string) {
  if (pendingManagement(state, threadId)) return undefined;
  if (
    Object.values(state.occurrences).some(
      (occurrence) =>
        occurrence.threadId === threadId && ["dispatching", "admitted"].includes(occurrence.state),
    )
  )
    return undefined;
  return Object.values(state.occurrences)
    .filter((occurrence) => occurrence.threadId === threadId && occurrence.state === "pending")
    .sort(
      (left, right) => left.scheduledAt - right.scheduledAt || left.id.localeCompare(right.id),
    )[0];
}

export function finishOccurrence(
  state: ScheduleDraft,
  occurrence: ScheduleOccurrence,
  status: "succeeded" | "failed" | "cancelled" | "skipped",
  now: number,
  reason?: string,
) {
  state.occurrences[occurrence.id] = {
    ...occurrence,
    state: status,
    finishedAt: now,
    ...(reason ? { reason } : {}),
  };
  const schedule = state.schedules[occurrence.scheduleId];
  if (
    schedule &&
    occurrence.source === "automatic" &&
    schedule.rule.type === "once" &&
    schedule.revision === occurrence.scheduleRevision &&
    schedule.state === "active"
  )
    state.schedules[schedule.id] = { ...schedule, state: "completed", nextRunAt: null };
}

export function scheduleThreadIds(state: ScheduleDraft) {
  return [
    ...new Set([
      ...Object.values(state.schedules)
        .filter((schedule) => schedule.deletedAt === undefined)
        .map((schedule) => schedule.threadId),
      ...Object.values(state.occurrences)
        .filter((occurrence) => ["pending", "dispatching", "admitted"].includes(occurrence.state))
        .map((occurrence) => occurrence.threadId),
      ...Object.values(state.requests)
        .filter((request) => request.state === "pending")
        .map((request) => request.threadId),
      ...Object.values(state.proposals)
        .filter((proposal) => proposal.state === "pending")
        .map((proposal) => proposal.threadId),
    ]),
  ];
}

export function markScheduleBlocked(state: ScheduleDraft, schedule: Schedule, reason?: string) {
  const { blockedReason: _blockedReason, ...rest } = schedule;
  state.schedules[schedule.id] = { ...rest, ...(reason ? { blockedReason: reason } : {}) };
}
