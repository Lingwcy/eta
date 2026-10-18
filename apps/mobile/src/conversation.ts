import { z } from "zod";
import { MessageSchema } from "./bot/contracts.ts";
import type { BotMessage, BotSnapshot } from "./bot/contracts.ts";

export function conversationRows(snapshot: BotSnapshot) {
  const calls = new Set(
    snapshot.transcript.flatMap(({ message }) =>
      typeof message.content === "string"
        ? []
        : message.content.filter((part) => part.type === "toolCall").map((part) => part.id),
    ),
  );
  const entries = snapshot.transcript.filter(
    ({ message }) => message.role !== "toolResult" || !calls.has(message.toolCallId),
  );
  const streaming = snapshot.operation?.streamingMessage;
  let last: BotMessage | undefined;
  for (let index = entries.length - 1; index >= 0; --index) {
    const message = entries[index]!.message;
    if (message.role === "user" || message.role === "assistant") {
      last = message;
      break;
    }
  }
  const saved =
    last?.role === "assistant" &&
    last.timestamp === streaming?.timestamp &&
    last.provider === streaming?.provider &&
    last.model === streaming?.model;
  const rows = entries.map(({ id, message }) => ({ id, message }));
  if (streaming && !saved) rows.push({ id: "streaming", message: streaming });
  const occurrences = new Map<string, number>();
  return rows
    .filter(
      ({ message }) =>
        message.role !== "assistant" ||
        Boolean(message.errorMessage) ||
        (typeof message.content === "string"
          ? Boolean(message.content.trim())
          : message.content.some(
              (part) =>
                part.type === "toolCall" ||
                part.type === "image" ||
                (part.type === "text" && part.text?.trim()) ||
                (part.type === "thinking" && part.thinking?.trim()),
            )),
    )
    .map(({ id, message }) => {
      if (message.role !== "assistant" || message.timestamp === undefined) return { id, message };
      const identity = `assistant:${message.timestamp}:${message.provider}:${message.model}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return { id: `${identity}:${occurrence}`, message };
    });
}

export function toolDescription(
  snapshot: Pick<BotSnapshot, "toolIntents">,
  id?: string,
  liveDescription?: string,
) {
  if (liveDescription !== undefined) return liveDescription;
  const intents = snapshot.toolIntents;
  if (id === undefined || !intents || !Object.hasOwn(intents, id)) return undefined;
  const description: unknown = intents[id];
  return typeof description === "string" ? description : undefined;
}

export function textContent(message: BotMessage) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}

export function taskLabel(snapshot?: BotSnapshot) {
  if (!snapshot) return "";
  if (snapshot.blockedReason) return snapshot.blockedReason;
  if (snapshot.recoveryRequired) return "任务需要恢复";
  if (snapshot.faulted) return "任务发生错误";
  if (snapshot.compacting) return "正在压缩上下文";
  const operation = snapshot.operation;
  if (operation?.status === "aborting") return "正在停止任务";
  if (operation?.waitingForApproval) return "等待审批";
  if (operation?.waitingForSubagents) return "等待子任务完成";
  if (operation?.retry) return `正在重试 ${operation.retry.attempt}/${operation.retry.maxAttempts}`;
  if (operation?.deferred) return "等待任务继续";
  if (operation) return "任务进行中";
  if (snapshot.lastResult?.status === "failed")
    return snapshot.lastResult.error?.message ?? "任务失败";
  if (snapshot.lastResult?.status === "aborted") return "任务已停止";
  if (snapshot.lastResult?.status === "completed") return "任务已完成";
  return "";
}

export function getToolSummary(name: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "exec") {
    const cmd = args.command ?? args.cmd ?? args.CommandLine;
    if (typeof cmd === "string") return cmd.trim().split("\n")[0]?.trim() ?? "";
  }
  if (lower === "edit" || lower === "write" || lower === "read" || lower.includes("file")) {
    const filePath =
      args.path ??
      args.filePath ??
      args.file_path ??
      args.TargetFile ??
      args.target_file ??
      args.AbsolutePath ??
      args.file;
    if (typeof filePath === "string") return filePath.trim();
  }
  if (lower.includes("search") || lower === "grep" || lower === "find") {
    const q = args.query ?? args.pattern ?? args.q ?? args.path;
    if (typeof q === "string") return q.trim();
  }
  if (lower.includes("url") || lower.includes("fetch") || lower.includes("http")) {
    const url = args.Url ?? args.url ?? args.uri;
    if (typeof url === "string") return url.trim();
  }
  const candidateKeys = [
    "path",
    "TargetFile",
    "target_file",
    "filePath",
    "file_path",
    "AbsolutePath",
    "file",
    "command",
    "cmd",
    "CommandLine",
    "query",
    "pattern",
    "url",
    "Url",
    "name",
    "id",
  ];
  for (const key of candidateKeys) {
    const val = args[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim().split("\n")[0]?.trim() ?? "";
    }
  }
  const stringValues = Object.values(args).filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (stringValues.length === 1 && stringValues[0]) {
    return stringValues[0].trim().split("\n")[0]?.trim() ?? "";
  }
  return "";
}

/** Only current generation is preparing; saved historical calls are never inferred to be executing. */
export function toolCallState(
  snapshot: BotSnapshot,
  message: BotMessage,
  id?: string,
  tools = buildToolIndex(snapshot),
): string {
  const result = tools.results.get(id);
  if (result) return result.toolStatus ?? "settled";
  const operation = snapshot.operation;
  if (
    !operation ||
    operation.status === "aborting" ||
    snapshot.recoveryRequired ||
    snapshot.faulted ||
    snapshot.blockedReason
  )
    return "incomplete";
  const stream = operation.streamingMessage;
  if (!operation.retry && !operation.deferred && stream === message) return "generating";
  return "incomplete";
}

export function toolStateLabel(status?: string, result?: Pick<BotMessage, "isError">): string {
  if (result?.isError) return "执行失败";
  switch (status) {
    case "generating":
      return "准备执行";
    case "pending":
      return "等待执行";
    case "running":
      return "执行中";
    case "waiting":
      return "等待批准";
    case "settled":
      return "已完成";
    case "stopped":
      return "已停止";
    case "incomplete":
      return "未完成";
    default:
      return result ? "已完成" : "未完成";
  }
}

const NestedCallsSchema = z.object({
  calls: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      args: z.string(),
      description: z.string().optional(),
      result: MessageSchema.pick({ content: true }).optional(),
      status: z.enum(["running", "ok", "error", "cancelled"]),
      error: z.string().optional(),
    }),
  ),
});

type NestedTool = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  description?: string;
  status: string;
  result?: BotMessage;
};
export type ToolIndex = ReturnType<typeof buildToolIndex>;

/** Build once per observed snapshot, not once per visible tool card. */
export function buildToolIndex(snapshot: BotSnapshot) {
  const results = new Map<string | undefined, BotSnapshot["transcript"][number]>();
  const messages = new Map<BotMessage, BotSnapshot["transcript"][number]>();
  const running = new Map<string, NonNullable<BotSnapshot["operation"]>["runningTools"][number]>();
  const previews = new Map<string | undefined, BotMessage[]>();
  const children = new Map<string | undefined, Map<string, NestedTool>>();
  const childRows = (parentId: string | undefined) => {
    let rows = children.get(parentId);
    if (!rows) {
      rows = new Map();
      children.set(parentId, rows);
    }
    return rows;
  };
  for (const entry of snapshot.transcript) {
    const { message } = entry;
    // Match the original find semantics when providers reuse call IDs.
    if (!messages.has(message)) messages.set(message, entry);
    if (message.role !== "toolResult") continue;
    if (!results.has(message.toolCallId)) results.set(message.toolCallId, entry);
    if (message.toolName !== "codemode") continue;
    const saved = previews.get(message.toolCallId);
    if (saved) saved.push(message);
    else previews.set(message.toolCallId, [message]);
  }
  for (const tool of snapshot.operation?.runningTools ?? []) {
    if (!running.has(tool.toolCallId)) running.set(tool.toolCallId, tool);
    if (!tool.parentToolCallId) continue;
    childRows(tool.parentToolCallId).set(tool.toolCallId, {
      id: tool.toolCallId,
      name: tool.toolName,
      args: tool.args,
      description: tool.description,
      status: tool.status,
      result: tool.result
        ? { role: "toolResult", content: tool.result.content, isError: tool.isError }
        : undefined,
    });
  }
  return {
    results,
    messages,
    running,
    previews,
    liveChildren: children,
    children: new Map<string | undefined, NestedTool[]>(),
  };
}

/** Nested previews may be truncated JSON, so their summary travels separately from args. */
export function nestedTools(
  snapshot: BotSnapshot,
  parentId?: string,
  tools = buildToolIndex(snapshot),
) {
  const cached = tools.children.get(parentId);
  if (cached) return cached;
  const rows = new Map<string, NestedTool>();
  for (const message of tools.previews.get(parentId) ?? []) {
    const parsed = NestedCallsSchema.safeParse(message.details);
    if (!parsed.success) continue;
    for (const call of parsed.data.calls) {
      const id = `${message.toolCallId}/c${call.id}`;
      rows.set(id, {
        id,
        name: call.name,
        args: { preview: call.args },
        description: call.description,
        status:
          call.status === "cancelled"
            ? "stopped"
            : call.status === "running"
              ? "incomplete"
              : "settled",
        result: {
          role: "toolResult",
          content: call.result?.content ?? (call.error ? [{ type: "text", text: call.error }] : []),
          isError: call.status === "error",
        },
      });
    }
  }
  for (const [id, row] of tools.liveChildren.get(parentId) ?? []) rows.set(id, row);
  const result = [...rows.values()];
  tools.children.set(parentId, result);
  return result;
}

/** Keep narrative and user turns separated while tool/thinking rows stay adjacent. */
export function isActivityMessage(message: BotMessage) {
  if (message.role !== "assistant" || typeof message.content === "string") return false;
  return (
    message.content.some(
      (part) => part.type === "toolCall" || (part.type === "thinking" && part.thinking?.trim()),
    ) &&
    !message.content.some(
      (part) => part.type === "image" || (part.type === "text" && part.text?.trim()),
    )
  );
}
