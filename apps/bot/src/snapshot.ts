import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SnapshotResponse } from "@eta/core/agent/protocol";

function displayMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type === "thinking") {
        const content = { ...part };
        delete content.thinkingSignature;
        return content;
      }
      if (part.type === "toolCall") {
        const content = { ...part };
        delete content.thoughtSignature;
        return content;
      }
      // textSignature carries display phase metadata used to distinguish progress and final text.
      return part;
    }),
  };
}

/** Provider continuation signatures stay in Core; clients only need display content. */
export function displaySnapshot<T extends SnapshotResponse>(response: T): T {
  const snapshot = response.snapshot;
  return {
    ...response,
    snapshot: {
      ...snapshot,
      transcript: snapshot.transcript.map((entry) => ({
        ...entry,
        message: entry.message.role === "assistant" ? displayMessage(entry.message) : entry.message,
      })),
      operation: snapshot.operation?.streamingMessage
        ? {
            ...snapshot.operation,
            streamingMessage: displayMessage(snapshot.operation.streamingMessage),
          }
        : snapshot.operation,
    },
  };
}
