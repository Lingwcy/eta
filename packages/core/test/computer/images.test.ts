import { expect, test } from "vite-plus/test";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import {
  boundComputerImages,
  computerImageDigest,
  computerImageDigests,
} from "../../src/computer/images.ts";

function observation(id: number): Message {
  const image: ImageContent = { type: "image", data: `desktop-${id}`, mimeType: "image/png" };
  return {
    role: "toolResult",
    toolCallId: String(id),
    toolName: "codemode",
    timestamp: id,
    isError: false,
    content: [{ type: "text", text: `frame-${id}` }, image],
    details: { computerImages: [computerImageDigest(image)] },
  };
}

test("keeps recent desktop observations without deleting durable history or unrelated images", () => {
  const messages: Message[] = Array.from({ length: 6 }, (_, id) => observation(id));
  const first = messages[0]!;
  if (first.role !== "toolResult") throw new Error("fixture");
  first.content.push({ type: "image", data: "read-image", mimeType: "image/png" });
  messages.push({
    role: "user",
    timestamp: 8,
    content: [{ type: "image", data: "user-image", mimeType: "image/png" }],
  });
  const before = structuredClone(messages);
  const bounded = boundComputerImages(messages);
  expect(messages).toEqual(before);
  expect(
    bounded.slice(0, 2).map((message) => (message.role === "toolResult" ? message.content : [])),
  ).toEqual([
    [
      { type: "text", text: "frame-0" },
      { type: "image", data: "read-image", mimeType: "image/png" },
    ],
    [{ type: "text", text: "frame-1" }],
  ]);
  expect(bounded.slice(2)).toEqual(messages.slice(2));
  expect(bounded[2]).toBe(messages[2]);
});

test("budgets explicitly emitted images within a single Code mode result and tolerates malformed metadata", () => {
  const first = observation(1);
  const second = observation(2);
  if (first.role !== "toolResult" || second.role !== "toolResult") throw new Error("fixture");
  first.content.push(...second.content);
  first.details = {
    computerImages: [
      ...computerImageDigests(first.details),
      ...computerImageDigests(second.details),
    ],
  };
  const bounded = boundComputerImages([first], 1)[0]!;
  expect(bounded.role === "toolResult" && bounded.content).toEqual([
    first.content[0],
    ...second.content,
  ]);
  expect(boundComputerImages([first], 0)[0]).toMatchObject({
    content: [first.content[0], second.content[0]],
  });
  expect(
    computerImageDigests({
      computerImages: [null, 1, "bad", ...computerImageDigests(second.details)],
    }),
  ).toHaveLength(1);
  expect(computerImageDigests(null)).toEqual([]);
});
