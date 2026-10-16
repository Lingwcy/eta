import type { SnapshotTool, AgentSnapshot } from "@eta/core/agent/protocol";
import { Option, Schema } from "effect";

const CodemodeDetails = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      args: Schema.String,
      status: Schema.Literals(["running", "ok", "error", "cancelled"]),
      error: Schema.optionalKey(Schema.String),
      taskId: Schema.optionalKey(Schema.String),
      parentTaskId: Schema.optionalKey(Schema.String),
      result: Schema.optionalKey(
        Schema.Struct({
          content: Schema.Array(
            Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
          ),
          details: Schema.optionalKey(Schema.Unknown),
        }),
      ),
    }),
  ),
});

/** Associate nested calls with the assistant message that owns their outermost call. */
export function toolsForMessage(tools: readonly SnapshotTool[], callIds: readonly string[]) {
  const selected = new Set(callIds);
  const byId = new Map(tools.map((tool) => [tool.toolCallId, tool]));
  return tools.filter((tool) => {
    const visited = new Set<string>();
    let id: string | undefined = tool.toolCallId;
    while (id !== undefined && !visited.has(id)) {
      if (selected.has(id)) return true;
      visited.add(id);
      id = byId.get(id)?.parentToolCallId;
    }
    return false;
  });
}

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
      if (message.toolName === "codemode") {
        const details = Option.getOrUndefined(
          Schema.decodeUnknownOption(CodemodeDetails)(message.details),
        );
        for (const call of details?.calls ?? []) {
          const id = `${message.toolCallId}/c${call.id}`;
          tools.set(id, {
            toolCallId: id,
            parentToolCallId: message.toolCallId,
            ...(call.taskId ? { taskId: call.taskId } : {}),
            ...(call.parentTaskId ? { parentTaskId: call.parentTaskId } : {}),
            toolName: call.name,
            status:
              call.status === "cancelled"
                ? "stopped"
                : call.status === "running"
                  ? "incomplete"
                  : "settled",
            // Upstream truncates this preview, so it may no longer be valid JSON.
            args: { preview: call.args },
            isError: call.status === "error",
            ...(call.result
              ? {
                  result: {
                    ...call.result,
                    content:
                      call.result.content.length || !call.error
                        ? [...call.result.content]
                        : [{ type: "text", text: call.error }],
                  },
                }
              : call.error
                ? { result: { content: [{ type: "text", text: call.error }] } }
                : {}),
          });
        }
      }
    }
  }
  for (const tool of snapshot.operation?.runningTools ?? []) tools.set(tool.toolCallId, tool);
  return [...tools.values()];
}
