import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSnapshot, SnapshotTool } from "@eta/core/agent/protocol";
import { getTools, toolsForMessage } from "./selectors.ts";

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

test("Code mode keeps nested call identity live and reconstructs completed and cancelled calls from history", () => {
  const value = snapshot();
  value.transcript = [
    {
      id: "code",
      type: "message",
      message: fauxAssistantMessage(
        fauxToolCall("codemode", { code: "await tools.read({path:'a'});" }, { id: "code-call" }),
        { stopReason: "toolUse" },
      ),
    },
    {
      id: "result",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "codemode",
        toolCallId: "code-call",
        content: [],
        isError: false,
        timestamp: 2,
        details: {
          calls: [
            { id: 1, name: "read", args: '{"path":"a"}', status: "ok" },
            { id: 2, name: "bash", args: '{"command":"truncated...', status: "cancelled" },
            { id: 3, name: "read", args: "{}", status: "error", error: "missing" },
          ],
        },
      },
    },
  ];
  const tools = getTools(value);
  expect(
    tools.map(({ toolCallId, status, parentToolCallId }) => ({
      toolCallId,
      status,
      parentToolCallId,
    })),
  ).toEqual([
    { toolCallId: "code-call", status: "settled", parentToolCallId: undefined },
    { toolCallId: "code-call/c1", status: "settled", parentToolCallId: "code-call" },
    { toolCallId: "code-call/c2", status: "stopped", parentToolCallId: "code-call" },
    { toolCallId: "code-call/c3", status: "settled", parentToolCallId: "code-call" },
  ]);
  expect(tools[3]).toMatchObject({
    isError: true,
    result: { content: [{ type: "text", text: "missing" }] },
  });
  expect(toolsForMessage(tools, ["code-call"])).toEqual(tools);
  expect(toolsForMessage(tools, ["another-message"])).toEqual([]);
});

test("message tool selection follows explicit parent identities through multiple nesting levels", () => {
  const tools: SnapshotTool[] = [
    { toolCallId: "parent", toolName: "codemode", args: {}, status: "running" },
    {
      toolCallId: "nested",
      parentToolCallId: "parent",
      toolName: "other",
      args: {},
      status: "running",
    },
    {
      toolCallId: "leaf",
      parentToolCallId: "nested",
      toolName: "read",
      args: {},
      status: "waiting",
    },
    { toolCallId: "parent/unrelated", toolName: "read", args: {}, status: "running" },
  ];
  expect(toolsForMessage(tools, ["parent"]).map((tool) => tool.toolCallId)).toEqual([
    "parent",
    "nested",
    "leaf",
  ]);
});

test("nested schedule results retain the receipt needed by the existing chat controls", () => {
  const value = snapshot();
  const receipt = {
    kind: "schedule",
    action: "create",
    requestId: "opaque",
    threadId: "thread",
    status: "applied",
    nextRunAt: null,
  };
  value.transcript = [
    {
      id: "schedule-script",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "script",
        toolName: "codemode",
        isError: false,
        timestamp: 2,
        content: [],
        details: {
          calls: [
            {
              id: 1,
              name: "schedule",
              args: "{}",
              status: "ok",
              taskId: "nested-task",
              parentTaskId: "parent-task",
              result: { content: [{ type: "text", text: "Created plan" }], details: receipt },
            },
          ],
        },
      },
    },
  ];
  expect(getTools(value)[1]).toMatchObject({
    parentToolCallId: "script",
    taskId: "nested-task",
    parentTaskId: "parent-task",
    result: { details: receipt, content: [{ type: "text", text: "Created plan" }] },
  });
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
