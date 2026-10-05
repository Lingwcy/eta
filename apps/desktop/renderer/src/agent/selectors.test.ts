import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSnapshot, SnapshotTool } from "../../../src/agent/protocol.ts";
import { getTools } from "./selectors.ts";

function snapshot(): AgentSnapshot {
  return {
    configuration: {
      model: { provider: "test-provider", modelId: "test-model" },
      thinkingLevel: "off",
    },
    transcript: [
      {
        id: "assistant",
        type: "message",
        message: fauxAssistantMessage(
          fauxToolCall("read", { path: "example.txt" }, { id: "read-file" }),
          { stopReason: "toolUse" },
        ),
      },
    ],
    operation: null,
    lastResult: null,
    faulted: false,
  };
}

test.each([false, true])("retains settled tool results and error status (%s)", (isError) => {
  const value = snapshot();
  const content = [{ type: "text" as const, text: isError ? "File missing" : "File content" }];
  value.transcript.push({
    id: "result",
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "read-file",
      toolName: "read",
      content,
      details: { path: "example.txt" },
      isError,
      timestamp: 1,
    },
  });
  expect(getTools(value)).toEqual([
    {
      toolCallId: "read-file",
      toolName: "read",
      status: "settled",
      args: { path: "example.txt" },
      result: { content, details: { path: "example.txt" } },
      isError,
    },
  ]);
});

test("live tool progress overrides the transcript call without duplicating it", () => {
  const value = snapshot();
  const tool: SnapshotTool = {
    toolCallId: "read-file",
    toolName: "read",
    status: "running",
    args: { path: "example.txt" },
    result: { content: [{ type: "text", text: "Partial output" }] },
  };
  value.operation = {
    id: "run",
    kind: "run",
    status: "running",
    startedAt: 1,
    fromTipId: null,
    runningTools: [tool],
  };
  expect(getTools(value)).toEqual([tool]);
});
