import type { SnapshotTool, AgentSnapshot } from "@eta/core/agent/protocol";
import { Option, Schema } from "effect";

const CodemodeDetails = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      args: Schema.String,
      description: Schema.optionalKey(Schema.String),
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

/** Build once per observation; message rows visit only their own calls and descendants. */
export function indexTools(tools: readonly SnapshotTool[]) {
  const byId = new Map(tools.map((tool, order) => [tool.toolCallId, { tool, order }]));
  const children = new Map<string, string[]>();
  for (const tool of tools) {
    if (!tool.parentToolCallId) continue;
    const siblings = children.get(tool.parentToolCallId) ?? [];
    siblings.push(tool.toolCallId);
    children.set(tool.parentToolCallId, siblings);
  }
  return { byId, children };
}

/** Preserve transcript order even when nested results arrive before their parent. */
export function toolsForMessage(index: ReturnType<typeof indexTools>, callIds: readonly string[]) {
  const visited = new Set<string>();
  const selected: { tool: SnapshotTool; order: number }[] = [];
  const pending = [...callIds];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const call = index.byId.get(id);
    if (call) selected.push(call);
    for (const child of index.children.get(id) ?? []) pending.push(child);
  }
  return selected.sort((a, b) => a.order - b.order).map(({ tool }) => tool);
}

function savedToolIntent(intents: AgentSnapshot["toolIntents"], id: string) {
  if (!intents || !Object.hasOwn(intents, id)) return undefined;
  const description: unknown = intents[id];
  return typeof description === "string" ? description : undefined;
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
            ...(call.description ? { description: call.description } : {}),
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
  const operation = snapshot.operation;
  const active =
    operation?.status === "running" &&
    !snapshot.recoveryRequired &&
    !snapshot.faulted &&
    !snapshot.blockedReason;
  if (active && !operation.retry && !operation.deferred) {
    for (const part of operation.streamingMessage?.content ?? []) {
      if (part.type !== "toolCall" || tools.has(part.id)) continue;
      tools.set(part.id, {
        toolCallId: part.id,
        toolName: part.name,
        args: part.arguments,
        status: "generating",
      });
    }
  }
  for (const tool of operation?.runningTools ?? []) tools.set(tool.toolCallId, tool);
  for (const [id, tool] of tools) {
    const description = tool.description ?? savedToolIntent(snapshot.toolIntents, id);
    if (description) tools.set(id, { ...tool, description });
  }
  return [...tools.values()];
}
