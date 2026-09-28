import type { LaneSnapshotTool, LaneTranscriptSnapshot } from "@eta/agent";

/** Reconstructs tool observations from the transcript, with live results overriding settled history. */
export function getTools(snapshot: LaneTranscriptSnapshot): LaneSnapshotTool[] {
  const tools = new Map<string, LaneSnapshotTool>();
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "toolCall")
          tools.set(content.id, {
            status: "running",
            toolCallId: content.id,
            toolName: content.name,
            args: content.arguments,
          });
      }
    } else if (message.role === "toolResult") {
      const tool = tools.get(message.toolCallId);
      tools.set(message.toolCallId, {
        status: "settled",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        args: tool?.args ?? {},
        result: { content: message.content, details: message.details },
        isError: message.isError,
      });
    }
  }
  for (const tool of snapshot.operation?.runningTools ?? []) tools.set(tool.toolCallId, tool);
  return [...tools.values()];
}

export function getThinkingLabel(snapshot: LaneTranscriptSnapshot): string {
  const operation = snapshot.operation;
  if (operation?.status === "aborting") return "正在停止";
  if (operation?.retry)
    return `正在重试 (${operation.retry.attempt}/${operation.retry.maxAttempts})`;
  if (operation?.deferred) return "等待模型返回结果";
  if (operation?.runningTools.some((tool) => tool.status === "running")) return "正在执行工具";
  return "正在思考";
}
