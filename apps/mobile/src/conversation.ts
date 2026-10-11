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
  const saved = entries.some(
    ({ message }) =>
      message.role === "assistant" &&
      message.timestamp === streaming?.timestamp &&
      message.provider === streaming?.provider &&
      message.model === streaming?.model,
  );
  const rows = entries.map(({ id, message }) => ({ id, message }));
  if (streaming && !saved) rows.push({ id: "streaming", message: streaming });
  const occurrences = new Map<string, number>();
  return rows.map(({ id, message }) => {
    if (message.role !== "assistant" || message.timestamp === undefined) return { id, message };
    const identity = `assistant:${message.timestamp}:${message.provider}:${message.model}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { id: `${identity}:${occurrence}`, message };
  });
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
