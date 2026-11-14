import { z } from "zod";
import { getMessages } from "./i18n/index.ts";
import { MessageSchema } from "./bot/contracts.ts";
import type { BotMessage, BotSnapshot } from "./bot/contracts.ts";

export function conversationRows(
  snapshot: BotSnapshot,
  submitted: readonly import("./bot/store.ts").SubmittedInput[] = [],
) {
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
  const rows = entries.map(({ id, message, requestId }) => ({
    id: requestId === undefined ? id : "input:" + requestId,
    message,
  }));
  if (streaming && !saved) rows.push({ id: "streaming", message: streaming });
  const placed = new Set(
    entries.flatMap((entry) => (entry.requestId === undefined ? [] : [entry.requestId])),
  );
  const local = new Map(
    submitted
      .filter((input) => !placed.has(input.messageId))
      .map((input) => [input.messageId, input]),
  );
  const shown = new Set<string>();
  for (const input of snapshot.queuedInputs ?? []) {
    if (input.requestId !== undefined && placed.has(input.requestId)) continue;
    const own = input.requestId === undefined ? undefined : local.get(input.requestId);
    if (input.requestId !== undefined) shown.add(input.requestId);
    rows.push({
      id:
        input.requestId === undefined ? "queued:" + input.operationId : "input:" + input.requestId,
      message: {
        role: "user",
        timestamp: input.submittedAt,
        content: own ? [{ type: "text", text: own.prompt }, ...(own.images ?? [])] : input.prompt,
      },
    });
  }
  for (const input of local.values()) {
    if (!shown.has(input.messageId))
      rows.push({
        id: "input:" + input.messageId,
        message: {
          role: "user",
          timestamp: input.submittedAt,
          content: [{ type: "text", text: input.prompt }, ...(input.images ?? [])],
        },
      });
  }
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
  const { conversation } = getMessages();
  if (snapshot.recoveryRequired) return conversation.recoveryRequired;
  if (snapshot.faulted) return conversation.faulted;
  if (snapshot.compacting) return conversation.compacting;
  const operation = snapshot.operation;
  if (operation?.status === "aborting") return conversation.aborting;
  if (operation?.waitingForApproval) return conversation.waitingForApproval;
  if (operation?.waitingForSubagents) return conversation.waitingForSubagents;
  if (operation?.retry)
    return conversation.retrying(operation.retry.attempt, operation.retry.maxAttempts);
  if (operation?.deferred) return conversation.deferred;
  if (operation) return conversation.running;
  if (snapshot.lastResult?.status === "failed")
    return snapshot.lastResult.error?.message ?? conversation.failed;
  if (snapshot.lastResult?.status === "aborted") return conversation.aborted;
  if (snapshot.lastResult?.status === "completed") return conversation.completed;
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
  const { toolState } = getMessages().conversation;
  if (result?.isError) return toolState.error;
  switch (status) {
    case "generating":
      return toolState.generating;
    case "pending":
      return toolState.pending;
    case "running":
      return toolState.running;
    case "waiting":
      return toolState.waiting;
    case "settled":
      return toolState.settled;
    case "stopped":
      return toolState.stopped;
    case "incomplete":
      return toolState.incomplete;
    default:
      return result ? toolState.settled : toolState.incomplete;
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

export type NestedToolView = NestedTool;

export type ThinkingStep = {
  type: "thinking";
  key: string;
  thinking: string;
  active: boolean;
};

export type PreambleStep = {
  type: "text";
  key: string;
  text: string;
};

export type ToolStep = {
  type: "tool";
  key: string;
  message: BotMessage;
  part: {
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
  result?: BotMessage;
  running?: NonNullable<BotSnapshot["operation"]>["runningTools"][number];
  status: string;
  description?: string;
  nested: NestedTool[];
};

export type FallbackStep = {
  type: "fallback";
  key: string;
  partType: string;
};

export type AssistantStep = ThinkingStep | PreambleStep | ToolStep | FallbackStep;

export type AssistantReplyView = {
  steps: AssistantStep[];
  answer: string | null;
  images: { data: string; mimeType: string }[];
  errors: string[];
  hasThinking: boolean;
  streaming: boolean;
  stoppedWithoutAnswer: boolean;
};

export function isAssistantStreaming(message: BotMessage, snapshot: BotSnapshot): boolean {
  return (
    snapshot.operation?.status === "running" &&
    (message === snapshot.operation.streamingMessage ||
      (!message.stopReason && message.role === "assistant"))
  );
}

function joinTextSegments(segments: { messageIndex: number; text: string }[]): string {
  let result = "";
  let prevMessageIndex: number | undefined;
  for (const segment of segments) {
    if (!segment.text) continue;
    if (
      prevMessageIndex !== undefined &&
      prevMessageIndex !== segment.messageIndex &&
      result &&
      !result.endsWith("\n") &&
      !segment.text.startsWith("\n")
    ) {
      result += "\n\n";
    }
    result += segment.text;
    prevMessageIndex = segment.messageIndex;
  }
  return result;
}

/**
 * Derive a unified chat-demo-style ReplyArea timeline + trailing answer
 * from one or more consecutive assistant messages in a turn.
 */
export function buildAssistantReplyView(
  messages: readonly BotMessage[],
  snapshot: BotSnapshot,
  tools: ToolIndex,
): AssistantReplyView {
  const steps: AssistantStep[] = [];
  const images: { data: string; mimeType: string }[] = [];
  const errors: string[] = [];
  let mergedThinking: ThinkingStep | null = null;
  let pendingText: { key: string; messageIndex: number; text: string }[] = [];
  let turnStreaming = false;

  const flushPreamble = () => {
    if (pendingText.length === 0) return;
    const joined = joinTextSegments(pendingText);
    if (joined.trim()) {
      steps.push({ type: "text", key: pendingText[0]!.key, text: joined });
    }
    pendingText = [];
  };

  messages.forEach((msg, messageIndex) => {
    const msgStreaming = isAssistantStreaming(msg, snapshot);
    if (msgStreaming) turnStreaming = true;
    if (msg.errorMessage) errors.push(msg.errorMessage);

    const parts =
      typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;

    parts.forEach((part, partIndex) => {
      if (part.type !== "thinking") {
        mergedThinking = null;
      }

      if (part.type === "text") {
        if (part.text) {
          pendingText.push({
            key: `text-${messageIndex}-${partIndex}`,
            messageIndex,
            text: part.text,
          });
        }
        return;
      }

      if (part.type === "thinking") {
        const text = part.thinking ?? "";
        if (!text.trim()) return;
        const active = msgStreaming && partIndex === parts.length - 1;
        if (mergedThinking) {
          if (
            mergedThinking.thinking &&
            !mergedThinking.thinking.endsWith("\n") &&
            !text.startsWith("\n")
          ) {
            mergedThinking.thinking += "\n\n";
          }
          mergedThinking.thinking += text;
          mergedThinking.active = mergedThinking.active || active;
        } else {
          flushPreamble();
          mergedThinking = {
            type: "thinking",
            key: `thinking-${messageIndex}-${partIndex}`,
            thinking: text,
            active,
          };
          steps.push(mergedThinking);
        }
        return;
      }

      if (part.type === "toolCall") {
        flushPreamble();
        const result = tools.results.get(part.id)?.message;
        const running = part.id === undefined ? undefined : tools.running.get(part.id);
        const stopped = tools.messages.get(msg)?.toolStatus;
        const nested = nestedTools(snapshot, part.id, tools);
        const status = running?.status ?? stopped ?? toolCallState(snapshot, msg, part.id, tools);
        steps.push({
          type: "tool",
          key: part.id ?? `tool-${messageIndex}-${partIndex}`,
          message: msg,
          part,
          result,
          running,
          status,
          description: toolDescription(snapshot, part.id, running?.description),
          nested,
        });
        return;
      }

      if (part.type === "image" && part.data && part.mimeType) {
        flushPreamble();
        images.push({ data: part.data, mimeType: part.mimeType });
        return;
      }

      flushPreamble();
      steps.push({
        type: "fallback",
        key: `fallback-${messageIndex}-${partIndex}`,
        partType: part.type,
      });
    });
  });

  const answerText = pendingText.length > 0 ? joinTextSegments(pendingText) : "";
  const answer = answerText.trim() ? answerText : null;
  const hasThinking = steps.some((step) => step.type === "thinking");
  const stoppedWithoutAnswer =
    !turnStreaming &&
    !answer &&
    (snapshot.lastResult?.status === "aborted" ||
      steps.some((step) => step.type === "tool" && step.status === "stopped"));

  return {
    steps,
    answer,
    images,
    errors,
    hasThinking,
    streaming: turnStreaming,
    stoppedWithoutAnswer,
  };
}

export type ConversationTurn =
  | { id: string; role: "user"; message: BotMessage }
  | { id: string; role: "toolResult"; message: BotMessage }
  | { id: string; role: "assistant"; messages: BotMessage[] };

/** Group consecutive assistant activity/reply rows into a single turn like chat-demo. */
export function conversationTurns(
  snapshot: BotSnapshot,
  submitted: readonly import("./bot/store.ts").SubmittedInput[] = [],
): ConversationTurn[] {
  const rows = conversationRows(snapshot, submitted);
  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    if (row.message.role === "assistant") {
      const prev = turns.at(-1);
      if (prev && prev.role === "assistant") {
        prev.messages.push(row.message);
      } else {
        turns.push({ id: row.id, role: "assistant", messages: [row.message] });
      }
    } else if (row.message.role === "user") {
      turns.push({ id: row.id, role: "user", message: row.message });
    } else {
      turns.push({ id: row.id, role: "toolResult", message: row.message });
    }
  }
  return turns;
}

export function isWaitingForReply(snapshot?: BotSnapshot, turns: readonly ConversationTurn[] = []) {
  if (!snapshot?.operation || snapshot.operation.status !== "running") return false;
  if (
    snapshot.operation.waitingForApproval ||
    snapshot.operation.retry ||
    snapshot.operation.deferred
  ) {
    return false;
  }
  const lastTurn = turns.at(-1);
  if (!lastTurn) return false;
  if (lastTurn.role !== "assistant") return true;
  return false;
}
