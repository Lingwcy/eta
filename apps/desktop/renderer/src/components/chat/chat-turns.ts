import type { AgentSnapshot } from "../../../../src/agent/protocol.ts";

export interface ChatTurn {
  id: string;
  title: string;
  preview: string;
}

/** One tick per user turn; tool rounds stay within that turn's preview. */
export function getChatTurns(
  messages: readonly Pick<AgentSnapshot["transcript"][number], "id" | "message">[],
): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const { id, message } of messages) {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    if (message.role === "user") turns.push({ id, title: text.trim() || "附件消息", preview: "" });
    else if (text && turns.length) {
      const turn = turns[turns.length - 1];
      if (turn) turn.preview = `${turn.preview}${turn.preview ? "\n" : ""}${text}`.slice(0, 500);
    }
  }
  return turns;
}

export function getActiveTurn(positions: { id: string; top: number }[], readingLine: number) {
  return positions.findLast(({ top }) => top <= readingLine)?.id ?? positions[0]?.id;
}
