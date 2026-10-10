import type { AgentSnapshot } from "@eta/core/agent/protocol";

export type ThinkingPhase =
  | "waiting"
  | "continuing"
  | "thinking"
  | "retrying"
  | "deferred"
  | "subagents";

/** Track each observed response phase so tool-round gaps stay visible without restarting their timer. */
export class ThinkingStatus {
  private runKey?: string;
  private responded = false;
  private phase: ThinkingPhase | null = null;
  private phaseKey?: string;
  startedAt = 0;

  update(
    threadId: string | null,
    snapshot?: AgentSnapshot,
    now = Date.now(),
  ): ThinkingPhase | null {
    const operation = snapshot?.operation;
    if (!operation) {
      this.runKey = undefined;
      this.responded = false;
      const waiting = Boolean(
        snapshot &&
        !snapshot.recoveryRequired &&
        !snapshot.faulted &&
        !snapshot.blockedReason &&
        !snapshot.compacting &&
        !snapshot.approvals?.length &&
        snapshot.subagents?.some(
          (child) => child.status === "running" || child.status === "queued",
        ),
      );
      return this.setPhase(
        waiting ? "subagents" : null,
        now,
        waiting ? `${threadId}:subagents` : undefined,
      );
    }
    const key = `${threadId}:${operation.id}`;
    if (key !== this.runKey) {
      this.runKey = key;
      this.responded = false;
      this.phase = null;
    }
    const content = operation.streamingMessage?.content ?? [];
    const activePart = content.findLast((part) =>
      part.type === "text"
        ? Boolean(part.text.trim())
        : part.type === "thinking"
          ? Boolean(part.thinking.trim())
          : true,
    );
    if (
      activePart ||
      operation.runningTools.length ||
      snapshot.transcript.some(
        ({ message }) =>
          message.role === "assistant" &&
          message.timestamp >= operation.startedAt &&
          message.content.length > 0,
      )
    )
      this.responded = true;
    let phase: ThinkingPhase | null = null;
    if (
      !snapshot.recoveryRequired &&
      !snapshot.faulted &&
      !snapshot.blockedReason &&
      !operation.waitingForApproval &&
      operation.status !== "aborting"
    ) {
      if (operation.waitingForSubagents) phase = "subagents";
      else if (!operation.runningTools.some((tool) => tool.status === "running")) {
        if (operation.retry) phase = "retrying";
        else if (operation.deferred) phase = "deferred";
        else if (activePart?.type === "thinking") phase = "thinking";
        else if (!activePart) phase = this.responded ? "continuing" : "waiting";
      }
    }
    const response = snapshot.transcript.findLast(
      ({ message }) =>
        (message.role === "assistant" || message.role === "toolResult") &&
        message.timestamp >= operation.startedAt,
    );
    // Fast tools can finish between delivered snapshots; the transcript still identifies the new round.
    const phaseKey = `${key}:${operation.streamingMessage?.timestamp ?? response?.id ?? ""}:${operation.retry?.attempt ?? ""}`;
    return this.setPhase(phase, phase === "waiting" ? operation.startedAt : now, phaseKey);
  }

  private setPhase(phase: ThinkingPhase | null, startedAt: number, phaseKey?: string) {
    if (phase !== this.phase || phaseKey !== this.phaseKey) {
      this.phase = phase;
      this.phaseKey = phaseKey;
      this.startedAt = startedAt;
    }
    return phase;
  }
}
