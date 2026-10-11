import { expect, test } from "vite-plus/test";
import { conversationRows, taskLabel } from "./conversation.ts";
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
