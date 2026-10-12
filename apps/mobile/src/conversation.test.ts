import { expect, test } from "vite-plus/test";
import { conversationRows, getToolSummary, taskLabel } from "./conversation.ts";
import { thread } from "./bot/fixtures.test-support.ts";
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
