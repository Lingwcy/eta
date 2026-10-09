import type { SnapshotTool, AgentSnapshot } from "../../../src/agent/protocol.ts";

/** Reconstructs tool observations from the transcript, with live results overriding settled history. */
export function getTools(snapshot: AgentSnapshot): SnapshotTool[] {
  const tools = new Map<string, SnapshotTool>();
  for (const entry of snapshot.transcript) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      for (const content of message.content) {
        if (content.type === "toolCall")
          tools.set(content.id, {
            // Forks can inherit a call without its result. Only live tools are executing here.
            status: "incomplete",
            toolCallId: content.id,
            toolName: content.name,
            args: content.arguments,
          });
      }
    } else if (message.role === "toolResult") {
      const tool = tools.get(message.toolCallId);
      tools.set(message.toolCallId, {
        status: entry.toolStatus ?? "settled",
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
