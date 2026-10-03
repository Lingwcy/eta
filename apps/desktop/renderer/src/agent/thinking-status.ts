import type { AgentSnapshot } from "../../../src/agent/protocol.ts";

export type ThinkingPhase = "waiting" | "thinking";

/** Once a run has responded, gaps between text and tool rounds are never initial waiting again. */
export class ThinkingStatus {
  private runKey?: string;
  private responded = false;

  update(threadId: string | null, snapshot?: AgentSnapshot): ThinkingPhase | null {
    const operation = snapshot?.operation;
    if (!operation) return null;
    const key = `${threadId}:${operation.id}`;
    if (key !== this.runKey) {
      this.runKey = key;
      this.responded = false;
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
    if (snapshot.recoveryRequired || snapshot.faulted || operation.status === "aborting")
      return null;
    if (operation.runningTools.some((tool) => tool.status === "running")) return null;
    if (activePart?.type === "thinking") return "thinking";
    return this.responded ? null : "waiting";
  }
}
