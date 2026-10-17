import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SnapshotResponse } from "@eta/core/agent/protocol";
import { messageText } from "@eta/core/agent/message-text";
import { displaySnapshot } from "./snapshot.ts";

test("display snapshots omit continuation payloads without modifying signed history or display phases", () => {
  const message = fauxAssistantMessage("Visible answer");
  message.content = [
    { type: "thinking", thinking: "Visible reasoning", thinkingSignature: "opaque".repeat(100000) },
    {
      type: "text",
      text: "Visible answer",
      textSignature: '{"v":1,"id":"msg","phase":"final_answer"}',
    },
    {
      type: "toolCall",
      id: "tool",
      name: "bash",
      arguments: { thinkingSignature: "user argument" },
      thoughtSignature: "provider-signature",
    },
  ];
  const response: SnapshotResponse = {
    contextTokens: 42,
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [{ id: "message", type: "message", message }],
      operation: {
        id: "operation",
        kind: "run",
        status: "running",
        startedAt: 1,
        fromTipId: null,
        runningTools: [],
        streamingMessage: message,
      },
      lastResult: null,
      toolIntents: { tool: "检查运行配置" },
      faulted: false,
      compacting: false,
    },
  };
  const displayed = displaySnapshot(response);
  expect(JSON.stringify(displayed).length).toBeLessThan(2000);
  const parts = displayed.snapshot.transcript[0]!.message.content;
  expect(parts).toEqual([
    { type: "thinking", thinking: "Visible reasoning" },
    message.content[1],
    {
      type: "toolCall",
      id: "tool",
      name: "bash",
      arguments: { thinkingSignature: "user argument" },
    },
  ]);
  expect(displayed.snapshot.operation?.streamingMessage?.content).toEqual(parts);
  expect(messageText(displayed.snapshot.transcript[0]!.message)).toBe(messageText(message));
  expect(message.content[0]).toHaveProperty("thinkingSignature");
  expect(message.content[2]).toHaveProperty("thoughtSignature", "provider-signature");
  expect(displayed.contextTokens).toBe(42);
  expect(displayed.snapshot.toolIntents).toEqual({ tool: "检查运行配置" });
});
