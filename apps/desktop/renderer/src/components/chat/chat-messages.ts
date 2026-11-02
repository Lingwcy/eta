import { inputMessageId, submittedMessages, type SubmittedInput } from "@/agent/submitted-inputs";
import type { AgentSnapshot } from "@eta/core/agent/protocol";

/** Streaming and saved responses share a key so saving never replays their entrance. */
export function getChatMessages(
  snapshot?: AgentSnapshot,
  submittedInputs: readonly SubmittedInput[] = [],
) {
  const entries =
    snapshot?.transcript.filter(
      ({ message }) => message.role === "user" || message.role === "assistant",
    ) ?? [];
  const streaming = snapshot?.operation?.streamingMessage;
  const last = entries.at(-1)?.message;
  const saved =
    last?.role === "assistant" &&
    last.timestamp === streaming?.timestamp &&
    last.provider === streaming.provider &&
    last.model === streaming.model;
  const messages = entries.map(({ id, message, requestId }) => ({
    id: requestId === undefined ? id : inputMessageId(requestId),
    sourceId: id,
    message,
    streaming: false,
  }));
  if (streaming && !saved)
    messages.push({
      id: "streaming",
      sourceId: "streaming",
      message: streaming,
      streaming:
        snapshot.operation?.status === "running" &&
        !snapshot.recoveryRequired &&
        !snapshot.faulted &&
        !snapshot.operation.retry &&
        !snapshot.operation.deferred,
    });
  if (snapshot)
    messages.push(
      ...submittedMessages(snapshot, submittedInputs).map((entry) => ({
        ...entry,
        sourceId: entry.id,
      })),
    );
  const occurrences = new Map<string, number>();
  return messages
    .filter(
      ({ message }) =>
        message.role !== "assistant" ||
        message.content.some(
          (part) =>
            part.type === "toolCall" ||
            (part.type === "text" && part.text.trim()) ||
            (part.type === "thinking" && part.thinking.trim()),
        ),
    )
    .map(({ id, message, streaming, sourceId }) => {
      if (message.role !== "assistant") return { id, message, streaming, sourceId };
      const identity = `assistant:${message.timestamp}:${message.provider}:${message.model}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return {
        id: `${identity}:${occurrence}`,
        message,
        streaming,
        sourceId,
      };
    });
}

/** Thinking and tool-only responses form one compact activity sequence. */
export function isActivityMessage(message: AgentSnapshot["transcript"][number]["message"]) {
  return (
    message.role === "assistant" &&
    message.content.some(
      (part) => part.type === "toolCall" || (part.type === "thinking" && part.thinking.trim()),
    ) &&
    !message.content.some((part) => part.type === "text" && part.text.trim())
  );
}
