import type { Message } from "@earendil-works/pi-ai";

/** Presentation text only: provider context and its signed content blocks remain untouched. */
export function messageText(message: Message) {
  if (typeof message.content === "string") return message.content;
  const text = message.content.filter((part) => part.type === "text");
  if (message.role !== "assistant") return text.map((part) => part.text).join("\n");
  const parts = text.map((part) => ({ part, phase: responsePhase(part.textSignature) }));
  const finalTexts = new Set(
    parts.filter(({ phase }) => phase === "final_answer").map(({ part }) => part.text),
  );
  // Responses can repeat a progress message verbatim as their final answer in the same response.
  // Only that explicit phase pair is redundant; unsigned or intentionally repeated text is retained.
  return parts
    .filter(({ part, phase }) => phase !== "commentary" || !finalTexts.has(part.text))
    .map(({ part }) => part.text)
    .join("\n");
}

function responsePhase(signature?: string) {
  if (!signature) return undefined;
  try {
    const value: unknown = JSON.parse(signature);
    if (
      value &&
      typeof value === "object" &&
      "v" in value &&
      value.v === 1 &&
      "id" in value &&
      typeof value.id === "string" &&
      "phase" in value &&
      (value.phase === "commentary" || value.phase === "final_answer")
    )
      return value.phase;
  } catch {
    // Legacy signatures and other providers' opaque signatures have no display phase.
  }
  return undefined;
}
