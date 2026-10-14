import type {
  ScheduleChange,
  ScheduleRequest,
  ScheduleSnapshot,
  ScheduleOccurrence,
} from "@eta/core/shared/schedules";

export const mapScheduleChange = (
  change: ScheduleChange,
  id: (value: string) => string,
): ScheduleChange =>
  change.action === "create" ? change : { ...change, scheduleId: id(change.scheduleId) };

/** Entity identities belong to an environment; request IDs and fingerprints remain opaque. */
export function mapScheduleRequest(
  value: ScheduleRequest,
  id: (value: string) => string,
): ScheduleRequest {
  return {
    ...value,
    threadId: id(value.threadId),
    ...(value.workspaceId ? { workspaceId: id(value.workspaceId) } : {}),
    ...(value.scheduleId ? { scheduleId: id(value.scheduleId) } : {}),
    ...(value.proposalId ? { proposalId: id(value.proposalId) } : {}),
    ...(value.occurrenceId ? { occurrenceId: id(value.occurrenceId) } : {}),
    ...(value.change ? { change: mapScheduleChange(value.change, id) } : {}),
  };
}
export function mapScheduleRun(
  value: ScheduleOccurrence,
  id: (value: string) => string,
): ScheduleOccurrence {
  return {
    ...value,
    id: id(value.id),
    scheduleId: id(value.scheduleId),
    threadId: id(value.threadId),
    ...(value.inputEntryId ? { inputEntryId: id(value.inputEntryId) } : {}),
    ...(value.operationId ? { operationId: id(value.operationId) } : {}),
  };
}
export function mapScheduleSnapshot(
  value: ScheduleSnapshot,
  id: (value: string) => string,
): ScheduleSnapshot {
  return {
    ...value,
    messageOrigins: value.messageOrigins?.map((origin) => ({
      ...origin,
      occurrenceId: id(origin.occurrenceId),
      scheduleId: id(origin.scheduleId),
      threadId: id(origin.threadId),
      inputEntryId: id(origin.inputEntryId),
      operationId: id(origin.operationId),
    })),
    occurrences: value.occurrences?.map((run) => mapScheduleRun(run, id)),
    schedules: value.schedules.map((schedule) => ({
      ...schedule,
      id: id(schedule.id),
      threadId: id(schedule.threadId),
      ...(schedule.workspaceId ? { workspaceId: id(schedule.workspaceId) } : {}),
    })),
    proposals: value.proposals.map((proposal) => ({
      ...proposal,
      id: id(proposal.id),
      threadId: id(proposal.threadId),
      workspaceId: id(proposal.workspaceId),
      change: mapScheduleChange(proposal.change, id),
      ...(proposal.scheduleId ? { scheduleId: id(proposal.scheduleId) } : {}),
    })),
    requests: value.requests.map((request) => mapScheduleRequest(request, id)),
    lifecycleIntents: value.lifecycleIntents.map((intent) => ({
      ...intent,
      threadId: id(intent.threadId),
      ...(intent.workspaceId ? { workspaceId: id(intent.workspaceId) } : {}),
    })),
  };
}
