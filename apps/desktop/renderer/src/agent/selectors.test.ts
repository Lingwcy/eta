import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSnapshot, SnapshotTool } from "@eta/core/agent/protocol";
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
  value.operation = null;
  expect(getTools(value)[0]?.status).toBe("incomplete");
});

test("forked or stopped calls without results do not appear to be executing", () => {
  const value = snapshot();
  expect(getTools(value)[0]).toMatchObject({ toolCallId: "read-file", status: "incomplete" });
  value.operation = {
    id: "child-run",
    kind: "run",
    status: "running",
    startedAt: 2,
    fromTipId: null,
    runningTools: [{ status: "running", toolCallId: "child-read", toolName: "read", args: {} }],
  };
  expect(getTools(value).map(({ toolCallId, status }) => ({ toolCallId, status }))).toEqual([
    { toolCallId: "read-file", status: "incomplete" },
    { toolCallId: "child-read", status: "running" },
  ]);
});

test("cancelled tools retain partial output and show stopped rather than failed", () => {
  const value = snapshot();
  const content = [{ type: "text" as const, text: "Partial output before cancellation" }];
  value.transcript.push({
    id: "cancelled-result",
    type: "message",
    toolStatus: "stopped",
    message: {
      role: "toolResult",
      toolCallId: "read-file",
      toolName: "read",
      content,
      isError: true,
      timestamp: 2,
    },
  });
  expect(getTools(value)).toEqual([
    {
      toolCallId: "read-file",
      toolName: "read",
      args: { path: "example.txt" },
      status: "stopped",
      result: { content, details: undefined },
      isError: true,
    },
  ]);
});
