import type { ScheduleStoreState } from "../../shared/schedules.ts";

export const MAX_SCHEDULE_RUN_HISTORY = 100;
export const MAX_HOST_RUN_HISTORY = 1000;
export const MAX_HOST_PROPOSAL_HISTORY = 200;
const terminalRuns = new Set(["succeeded", "failed", "cancelled", "skipped"]);

/** Compact request receipts and slot cursors outlive the bounded, content-bearing histories. */
export function trimScheduleHistory(state: ScheduleStoreState): ScheduleStoreState {
  const messageOrigins = { ...state.messageOrigins };
  for (const run of Object.values(state.occurrences)) {
    if (run.inputEntryId && run.operationId)
      messageOrigins[run.id] = {
        occurrenceId: run.id,
        scheduleId: run.scheduleId,
        threadId: run.threadId,
        inputEntryId: run.inputEntryId,
        operationId: run.operationId,
        requestId: run.requestId,
        name: run.name,
        scheduledAt: run.scheduledAt,
      };
  }
  const occurrences = { ...state.occurrences };
  const proposals = { ...state.proposals };
  const counts = new Map<string, number>();
  let keptRuns = 0;
  const runs = Object.values(occurrences)
    .filter((occurrence) => terminalRuns.has(occurrence.state))
    .sort(
      (left, right) =>
        (right.finishedAt ?? right.scheduledAt) - (left.finishedAt ?? left.scheduledAt) ||
        left.id.localeCompare(right.id),
    );
  for (const run of runs) {
    const count = counts.get(run.scheduleId) ?? 0;
    if (count >= MAX_SCHEDULE_RUN_HISTORY || keptRuns >= MAX_HOST_RUN_HISTORY)
      delete occurrences[run.id];
    else {
      counts.set(run.scheduleId, count + 1);
      keptRuns++;
    }
  }
  const protectedProposals = new Set(
    Object.values(state.requests)
      .filter((request) => request.state === "pending" && request.proposalId)
      .map((request) => request.proposalId),
  );
  const completedProposals = Object.values(proposals)
    .filter((proposal) => proposal.state !== "pending" && !protectedProposals.has(proposal.id))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
  for (const proposal of completedProposals.slice(MAX_HOST_PROPOSAL_HISTORY))
    delete proposals[proposal.id];
  const requests = Object.fromEntries(
    Object.entries(state.requests).map(([id, request]) => {
      if (request.state === "pending") return [id, request];
      const { change: _change, ...receipt } = request;
      return [id, receipt];
    }),
  );
  return {
    ...state,
    ...(Object.keys(messageOrigins).length ? { messageOrigins } : {}),
    occurrences,
    proposals,
    requests,
  };
}
