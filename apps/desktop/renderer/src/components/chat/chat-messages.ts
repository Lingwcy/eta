import type { AgentSnapshot } from "../../../../src/agent/protocol.ts";

/** Streaming and saved responses share a key so saving never replays their entrance. */
export function getChatMessages(snapshot?: AgentSnapshot) {
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
  const messages = entries.map(({ id, message }) => ({ id, message }));
  if (streaming && !saved) messages.push({ id: "streaming", message: streaming });
  const occurrences = new Map<string, number>();
  return messages.map(({ id, message }) => {
    if (message.role !== "assistant") return { id, message };
    const identity = `assistant:${message.timestamp}:${message.provider}:${message.model}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { id: `${identity}:${occurrence}`, message };
  });
}
