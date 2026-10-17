import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { OperationResult, SnapshotResponse } from "@eta/core/agent/protocol";
import { messageText } from "@eta/core/agent/message-text";
import { displayOperation, displaySnapshot } from "./snapshot.ts";

test("operation display preserves receipt metadata, display phases and business payloads", () => {
  const assistant = fauxAssistantMessage("Visible answer");
  assistant.content = [
    { type: "thinking", thinking: "Reasoning", thinkingSignature: "internal-thinking" },
    { type: "text", text: "Visible answer", textSignature: '{"phase":"final_answer"}' },
    {
      type: "toolCall",
      id: "tool",
      name: "example",
      arguments: { thoughtSignature: "business argument" },
      thoughtSignature: "internal-tool",
    },
  ];
  const operation: OperationResult = {
    operationId: "2",
    originOperationId: "1",
    inputEntryId: "entry:0",
    kind: "run",
    status: "completed",
    startedAt: 1,
    endedAt: 2,
    messages: [
      assistant,
      { role: "user", content: "Literal thinkingSignature", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "tool",
        toolName: "example",
        content: [{ type: "text", text: "Business result" }],
        details: { thinkingSignature: "business detail" },
        isError: false,
        timestamp: 2,
      },
    ],
  };
  const original = JSON.stringify(operation);
  const displayed = displayOperation(operation);
  expect(displayed).toMatchObject({
    operationId: "2",
    originOperationId: "1",
    inputEntryId: "entry:0",
    kind: "run",
    status: "completed",
    startedAt: 1,
    endedAt: 2,
  });
  expect(displayed.messages[0]?.content).toEqual([
    { type: "thinking", thinking: "Reasoning" },
    assistant.content[1],
    {
      type: "toolCall",
      id: "tool",
      name: "example",
      arguments: { thoughtSignature: "business argument" },
    },
  ]);
  expect(displayed.messages.slice(1)).toEqual(operation.messages.slice(1));
  expect(JSON.stringify(operation)).toBe(original);
});

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
