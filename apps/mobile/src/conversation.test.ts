import { expect, test } from "vite-plus/test";
import {
  buildToolIndex,
  conversationRows,
  textContent,
  getToolSummary,
  taskLabel,
  toolCallState,
  toolDescription,
  toolStateLabel,
  nestedTools,
  isActivityMessage,
} from "./conversation.ts";
import { thread } from "./bot/fixtures.test-support.ts";
import { SnapshotSchema } from "./bot/contracts.ts";
import type { BotMessage, BotSnapshot } from "./bot/contracts.ts";

test("streaming replies keep their identity when saved and are not rendered twice", () => {
  const message: BotMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    timestamp: 10,
    provider: "test",
    model: "one",
  };
  const snapshot: BotSnapshot = {
    ...thread.snapshot,
    operation: { id: "operation", status: "running", runningTools: [], streamingMessage: message },
  };
  const streaming = conversationRows(snapshot);
  const saved = conversationRows({ ...snapshot, transcript: [{ id: "persisted-id", message }] });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.id).toBe(streaming[0]?.id);
});

test.each([true, false])(
  "a previous turn cannot hide the current stream (metadata=%s)",
  (metadata) => {
    const identity = metadata ? { timestamp: 10, provider: "test", model: "one" } : {};
    const previous: BotMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer" }],
      ...identity,
    };
    const current: BotMessage = {
      ...previous,
      content: [{ type: "text", text: "Current answer" }],
    };
    const value = SnapshotSchema.parse({
      ...thread.snapshot,
      transcript: [
        { id: "old", message: previous },
        { id: "user", message: { role: "user", content: "Next question", timestamp: 10 } },
      ],
      operation: { id: "current", status: "running", runningTools: [], streamingMessage: current },
    });
    const rows = conversationRows(value);
    expect(rows.map(({ message }) => textContent(message))).toEqual([
      "Earlier answer",
      "Next question",
      "Current answer",
    ]);
    const id = rows.at(-1)?.id;
    const stream = value.operation!.streamingMessage!;
    const saved = conversationRows(
      SnapshotSchema.parse({
        ...value,
        transcript: [...value.transcript, { id: "saved", message: stream }],
      }),
    );
    expect(saved).toHaveLength(3);
    if (metadata) expect(saved.at(-1)?.id).toBe(id);
    expect(new Set(saved.map(({ id }) => id)).size).toBe(3);
  },
);

test("an orphan result after the saved assistant does not duplicate the current stream", () => {
  const message: BotMessage = {
    role: "assistant",
    timestamp: 10,
    provider: "test",
    model: "one",
    content: [{ type: "text", text: "Saved reply" }],
  };
  const value = SnapshotSchema.parse({
    ...thread.snapshot,
    transcript: [
      { id: "saved", message },
      {
        id: "orphan",
        message: {
          role: "toolResult",
          toolCallId: "missing",
          toolName: "read",
          content: [{ type: "text", text: "Recovered result" }],
        },
      },
    ],
    operation: { id: "current", status: "running", runningTools: [], streamingMessage: message },
  });
  expect(conversationRows(value).map(({ message }) => textContent(message))).toEqual([
    "Saved reply",
    "Recovered result",
  ]);
});

test("status distinguishes waiting for approval, recovery and cancellation", () => {
  const snapshot = {
    ...thread.snapshot,
    operation: {
      id: "operation",
      status: "running" as const,
      runningTools: [],
      waitingForApproval: true,
    },
  };
  expect(taskLabel(snapshot)).toBe("等待审批");
  expect(taskLabel({ ...snapshot, recoveryRequired: true })).toBe("任务需要恢复");
  expect(taskLabel({ ...snapshot, operation: { ...snapshot.operation, status: "aborting" } })).toBe(
    "正在停止任务",
  );
  expect(taskLabel({ ...thread.snapshot, blockedReason: "Missing workspace" })).toBe(
    "Missing workspace",
  );
});

test("tool results without a saved call stay visible in recovered history", () => {
  const rows = conversationRows({
    ...thread.snapshot,
    transcript: [
      {
        id: "result",
        message: {
          role: "toolResult",
          toolCallId: "unavailable-call",
          toolName: "write",
          content: [{ type: "text", text: "Result" }],
        },
      },
    ],
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.message.role).toBe("toolResult");
});

test("getToolSummary extracts concise rough info for compact single-row display", () => {
  // bash tool shows command
  expect(getToolSummary("bash", { command: "git status -s" })).toBe("git status -s");
  expect(getToolSummary("bash", { CommandLine: "npm run test\n--watch" })).toBe("npm run test");

  // edit tool shows file path
  expect(getToolSummary("edit", { path: "apps/mobile/src/screens/chat.tsx" })).toBe(
    "apps/mobile/src/screens/chat.tsx",
  );
  expect(getToolSummary("edit", { TargetFile: "/Users/dev/project/index.ts" })).toBe(
    "/Users/dev/project/index.ts",
  );

  // write tool shows file path
  expect(getToolSummary("write", { file_path: "src/components/message.tsx" })).toBe(
    "src/components/message.tsx",
  );

  // read tool shows file path
  expect(getToolSummary("read", { AbsolutePath: "/etc/hosts" })).toBe("/etc/hosts");

  // search/grep shows query
  expect(getToolSummary("grep", { query: "ComposerInput" })).toBe("ComposerInput");

  // web search / url
  expect(getToolSummary("read_url_content", { Url: "https://example.com" })).toBe(
    "https://example.com",
  );

  // generic tool fallback
  expect(getToolSummary("custom_tool", { prompt: "summarize this" })).toBe("summarize this");
  expect(getToolSummary("empty_tool", {})).toBe("");
  expect(getToolSummary("no_args")).toBe("");
});

test.each(["constructor", "toString", "__proto__"])(
  "does not treat inherited tool intent properties as summaries (%s)",
  (id) => {
    expect(toolDescription(thread.snapshot, id)).toBeUndefined();
    expect(
      toolDescription({ ...thread.snapshot, toolIntents: JSON.parse("{}") }, id),
    ).toBeUndefined();
  },
);

test("tool descriptions require own string summaries and keep live values first", () => {
  const saved = { ...thread.snapshot, toolIntents: JSON.parse('{"constructor":"Saved summary"}') };
  expect(toolDescription(saved, "constructor")).toBe("Saved summary");
  expect(toolDescription(saved, "constructor", "Live summary")).toBe("Live summary");

  const invalid = {
    ...thread.snapshot,
    toolIntents: JSON.parse('{"constructor":false}') as unknown as BotSnapshot["toolIntents"],
  };
  expect(toolDescription(invalid, "constructor")).toBeUndefined();
});

test("mobile transport retains summaries and derives generating only from the current stream", () => {
  const message: BotMessage = {
    role: "assistant",
    content: [
      { type: "toolCall", id: "call", name: "write", arguments: { description: "保存内容" } },
    ],
  };
  const snapshot = SnapshotSchema.parse({
    ...thread.snapshot,
    toolIntents: { call: "保存内容" },
    operation: { id: "new", status: "running", streamingMessage: message, runningTools: [] },
  });
  const streaming = snapshot.operation!.streamingMessage!;
  expect(snapshot.toolIntents).toEqual({ call: "保存内容" });
  expect(toolCallState(snapshot, streaming, "call")).toBe("generating");
  expect(toolStateLabel("generating")).toBe("准备执行");
  expect(toolStateLabel("pending")).toBe("等待执行");
  expect(toolCallState({ ...snapshot, operation: null }, streaming, "call")).toBe("incomplete");
  expect(toolCallState({ ...snapshot, recoveryRequired: true }, streaming, "call")).toBe(
    "incomplete",
  );
  const retry = {
    ...snapshot,
    operation: { ...snapshot.operation!, retry: { attempt: 2, maxAttempts: 4 } },
  };
  expect(toolCallState(retry, streaming, "call")).toBe("incomplete");
});

test("nested summaries survive truncated arguments and live results override saved previews", () => {
  const snapshot = SnapshotSchema.parse({
    ...thread.snapshot,
    transcript: [
      {
        id: "result",
        message: {
          role: "toolResult",
          toolCallId: "script",
          toolName: "codemode",
          content: [],
          details: {
            calls: [
              {
                id: 1,
                name: "write",
                args: '{"content":"truncated',
                description: "保存内容",
                status: "error",
                error: "Permission denied",
                result: { content: [{ type: "text", text: "Saved tool output" }] },
              },
            ],
          },
        },
      },
    ],
    operation: {
      id: "run",
      status: "running",
      runningTools: [
        {
          toolCallId: "script/c1",
          parentToolCallId: "script",
          toolName: "write",
          description: "保存内容",
          args: { path: "a.txt" },
          status: "running",
        },
      ],
    },
  });
  const liveTools = buildToolIndex(snapshot);
  expect(nestedTools(snapshot, "script", liveTools)).toMatchObject([
    { id: "script/c1", description: "保存内容", status: "running", args: { path: "a.txt" } },
  ]);
  snapshot.operation = null;
  expect(nestedTools(snapshot, "script", liveTools)[0]?.status).toBe("running");
  expect(nestedTools(snapshot, "script")).toMatchObject([
    { id: "script/c1", description: "保存内容", status: "settled", result: { isError: true } },
  ]);
  expect(toolStateLabel("settled", nestedTools(snapshot, "script")[0]!.result)).toBe("执行失败");
  expect(nestedTools(snapshot, "script")[0]!.result!.content).toEqual([
    { type: "text", text: "Saved tool output" },
  ]);
});

test("mobile keeps only consecutive thinking and tool-only messages compact", () => {
  const thinking: BotMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Inspect concurrency" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "config.ts" } },
    ],
  };
  expect(isActivityMessage(thinking)).toBe(true);
  expect(
    isActivityMessage({
      ...thinking,
      content: [
        { type: "thinking", thinking: "Inspect concurrency" },
        { type: "text", text: "Summary" },
      ],
    }),
  ).toBe(false);
  expect(
    isActivityMessage({
      ...thinking,
      content: [{ type: "image", data: "test", mimeType: "image/png" }],
    }),
  ).toBe(false);
  expect(isActivityMessage({ role: "user", content: "Next task" })).toBe(false);
  expect(isActivityMessage({ role: "assistant", content: [] })).toBe(false);
});

test("empty assistant rows do not reserve vertical spacing", () => {
  const snapshot: BotSnapshot = {
    ...thread.snapshot,
    transcript: [
      { id: "empty", message: { role: "assistant", content: [] } },
      {
        id: "blank",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "  " }] },
      },
      { id: "visible", message: { role: "assistant", content: "Reply" } },
    ],
  };
  expect(conversationRows(snapshot)).toEqual([
    { id: "visible", message: { role: "assistant", content: "Reply" } },
  ]);
});

test("tool indexes keep first matches, stopped messages and each snapshot's live state", () => {
  const message: BotMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "write", arguments: {} }],
  };
  const first = {
    id: "first",
    message: { role: "toolResult" as const, toolCallId: "call", content: "First output" },
    toolStatus: "stopped",
  };
  const snapshot: BotSnapshot = {
    ...thread.snapshot,
    transcript: [
      { id: "assistant", message, toolStatus: "stopped" },
      { id: "duplicate-message", message, toolStatus: "settled" },
      first,
      { id: "second", message: { ...first.message, content: "Later output" } },
    ],
    operation: {
      id: "run",
      status: "running",
      streamingMessage: message,
      runningTools: [
        { toolCallId: "call", toolName: "write", args: {}, status: "running" },
        { toolCallId: "call", toolName: "write", args: {}, status: "waiting" },
      ],
    },
  };
  const tools = buildToolIndex(snapshot);
  expect(tools.results.get("call")).toBe(first);
  expect(tools.messages.get(message)?.toolStatus).toBe("stopped");
  expect(tools.running.get("call")?.status).toBe("running");
  expect(toolCallState(snapshot, message, "call", tools)).toBe("stopped");
  const next = { ...snapshot, transcript: [], operation: null };
  const updated = buildToolIndex(next);
  expect(updated.results.has("call")).toBe(false);
  expect(updated.running.has("call")).toBe(false);
  expect(toolCallState(next, message, "call", updated)).toBe("incomplete");
  expect(tools.results.get("call")).toBe(first);
});

test("shared tool queries do not revisit history or decode unseen nested previews", () => {
  let visits = 0;
  let decoded = 0;
  const transcript: BotSnapshot["transcript"] = Array.from({ length: 2000 }, (_, index) => ({
    id: String(index),
    get message(): BotMessage {
      visits++;
      return {
        role: "toolResult",
        toolName: "codemode",
        toolCallId: String(index),
        content: [],
        get details() {
          decoded++;
          return { calls: [{ id: 1, name: "write", args: "{}", status: "ok" }] };
        },
      };
    },
  }));
  const snapshot = { ...thread.snapshot, transcript };
  const tools = buildToolIndex(snapshot);
  expect(visits).toBe(transcript.length);
  expect(decoded).toBe(0);
  for (let i = 0; i < 30; i++) {
    const id = String(i);
    expect(tools.results.get(id)?.id).toBe(id);
    expect(toolCallState(snapshot, { role: "assistant", content: [] }, id, tools)).toBe("settled");
    expect(nestedTools(snapshot, id, tools)).toMatchObject([{ name: "write", status: "settled" }]);
    expect(nestedTools(snapshot, id, tools)).toBe(nestedTools(snapshot, id, tools));
  }
  expect(visits).toBe(transcript.length);
  expect(decoded).toBe(30);
});
