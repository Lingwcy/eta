import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { OperationResult, SnapshotResponse } from "@eta/core/agent/protocol";

/** HTTP admission namespaces requests internally; observations return the caller's original identity. */
function messageRequestId(requestId: string) {
  const prefix = "http:messages:";
  return requestId.startsWith(prefix) ? requestId.slice(prefix.length) : requestId;
}

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

/** Operation polling is a display boundary too; keep the original receipt and messages in Core. */
export function displayOperation(operation: OperationResult): OperationResult {
  return {
    ...operation,
    messages: operation.messages.map((message) =>
      message.role === "assistant" ? displayMessage(message) : message,
    ),
  };
}

/** Provider continuation signatures stay in Core; clients only need display content. */
export function displaySnapshot<T extends SnapshotResponse>(response: T): T {
  const snapshot = response.snapshot;
  return {
    ...response,
    snapshot: {
      ...snapshot,
      ...(snapshot.queuedInputs
        ? {
            queuedInputs: snapshot.queuedInputs.map((input) => ({
              ...input,
              ...(input.requestId === undefined
                ? {}
                : { requestId: messageRequestId(input.requestId) }),
            })),
          }
        : {}),
      transcript: snapshot.transcript.map((entry) => ({
        ...entry,
        ...(entry.requestId === undefined ? {} : { requestId: messageRequestId(entry.requestId) }),
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
