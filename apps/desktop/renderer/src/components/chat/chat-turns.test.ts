import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getActiveTurn, getChatTurns } from "./chat-turns";

test("navigation groups assistant tool rounds under their user turn", () => {
  const messages: Parameters<typeof getChatTurns>[0] = [
    { id: "first", message: { role: "user", content: "第一轮", timestamp: 1 } },
    { id: "answer", message: fauxAssistantMessage("先检查文件") },
    {
      id: "tools",
      message: fauxAssistantMessage({ type: "toolCall", id: "call", name: "bash", arguments: {} }),
    },
    { id: "result", message: fauxAssistantMessage("已完成修改") },
    { id: "second", message: { role: "user", content: "第二轮", timestamp: 2 } },
  ];
  expect(getChatTurns(messages)).toEqual([
    { id: "first", title: "第一轮", preview: "先检查文件\n已完成修改" },
    { id: "second", title: "第二轮", preview: "" },
  ]);
});

test("preview remains bounded while a long reply streams", () => {
  const turns = getChatTurns([
    { id: "user", message: { role: "user", content: "问题", timestamp: 1 } },
    { id: "reply", message: fauxAssistantMessage("a".repeat(1000)) },
  ]);
  expect(turns[0]?.preview).toHaveLength(500);
});

test("reading position selects the last turn above the viewport reading line", () => {
  const positions = [
    { id: "first", top: -100 },
    { id: "second", top: 200 },
  ];
  expect(getActiveTurn(positions, 48)).toBe("first");
  expect(getActiveTurn(positions, 240)).toBe("second");
  expect(getActiveTurn(positions, -200)).toBe("first");
  expect(getActiveTurn([], 48)).toBeUndefined();
});
