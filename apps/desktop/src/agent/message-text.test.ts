import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { messageText } from "./message-text.ts";

const signed = (text: string, phase: "commentary" | "final_answer") => ({
  type: "text" as const,
  text,
  textSignature: JSON.stringify({ v: 1, id: `message-${phase}`, phase }),
});

test("a signed commentary repeated as the final answer displays once without rewriting history", () => {
  const text = "已委托 subagent 计算，正在等待结果。";
  const message = fauxAssistantMessage([
    { type: "thinking", thinking: "" },
    signed(text, "commentary"),
    { type: "thinking", thinking: "" },
    signed(text, "final_answer"),
  ]);
  const original = structuredClone(message);
  expect(messageText(message)).toBe(text);
  expect(message).toEqual(original);
});

test("distinct progress and final text are both retained", () => {
  expect(
    messageText(
      fauxAssistantMessage([
        signed("正在计算。", "commentary"),
        signed("1+1 = 2。", "final_answer"),
      ]),
    ),
  ).toBe("正在计算。\n1+1 = 2。");
});

test("repetition without an explicit commentary/final pair is not deduplicated", () => {
  expect(
    messageText(
      fauxAssistantMessage([
        { type: "text", text: "Repeat" },
        { type: "text", text: "Repeat" },
      ]),
    ),
  ).toBe("Repeat\nRepeat");
  expect(
    messageText(
      fauxAssistantMessage([signed("Repeat", "final_answer"), signed("Repeat", "final_answer")]),
    ),
  ).toBe("Repeat\nRepeat");
  expect(
    messageText(
      fauxAssistantMessage([signed("Repeat", "commentary"), signed("Repeat", "commentary")]),
    ),
  ).toBe("Repeat\nRepeat");
});

test.each([
  undefined,
  "opaque-signature",
  "{broken",
  "null",
  "[]",
  JSON.stringify({ v: 2, id: "final", phase: "final_answer" }),
  JSON.stringify({ v: 1, phase: "final_answer" }),
])("unknown signature %s cannot cause text to disappear", (textSignature) => {
  expect(
    messageText(
      fauxAssistantMessage([
        signed("Repeat", "commentary"),
        { type: "text", text: "Repeat", textSignature },
      ]),
    ),
  ).toBe("Repeat\nRepeat");
});

test("user-authored text remains verbatim even with similarly shaped metadata", () => {
  const content = [signed("Repeat", "commentary"), signed("Repeat", "final_answer")];
  expect(messageText({ role: "user", content, timestamp: 1 })).toBe("Repeat\nRepeat");
  expect(messageText({ role: "user", content: "Repeat\nRepeat", timestamp: 1 })).toBe(
    "Repeat\nRepeat",
  );
});

test("a streaming commentary remains visible until a matching signed final block arrives", () => {
  const progress = signed("正在等待结果。", "commentary");
  const message = fauxAssistantMessage([progress]);
  expect(messageText(message)).toBe(progress.text);
  message.content.push(signed(progress.text, "final_answer"));
  expect(messageText(message)).toBe(progress.text);
});
