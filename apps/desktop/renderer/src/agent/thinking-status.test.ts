import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";
import { ThinkingStatus } from "./thinking-status";
import type { SubagentSummary } from "../../../src/shared/subagents.ts";

function snapshot(operation: Partial<NonNullable<AgentSnapshot["operation"]>> = {}): AgentSnapshot {
  return {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "high" },
    transcript: [],
    operation: {
      id: "run",
      kind: "run",
      startedAt: 100,
      status: "running",
      fromTipId: null,
      runningTools: [],
      ...operation,
    },
    lastResult: null,
    faulted: false,
  };
}

test("waiting for the next response appears between tool rounds without repeating initial waiting", () => {
  const status = new ThinkingStatus();
  expect(status.update("thread", snapshot())).toBe("waiting");
  expect(
    status.update("thread", snapshot({ streamingMessage: fauxAssistantMessage("Hello") })),
  ).toBeNull();
  expect(status.update("thread", snapshot())).toBe("continuing");
  expect(
    status.update(
      "thread",
      snapshot({
        runningTools: [{ toolCallId: "call", toolName: "bash", args: {}, status: "running" }],
      }),
    ),
  ).toBeNull();
  expect(status.update("thread", snapshot())).toBe("continuing");
});

test("only an active thinking part shows reasoning, not a thinking part retained before text", () => {
  const status = new ThinkingStatus();
  const reasoning = { type: "thinking" as const, thinking: "Let me consider this" };
  expect(
    status.update("thread", snapshot({ streamingMessage: fauxAssistantMessage(reasoning) })),
  ).toBe("thinking");
  expect(
    status.update(
      "thread",
      snapshot({
        streamingMessage: fauxAssistantMessage([reasoning, { type: "text", text: "Answer" }]),
      }),
    ),
  ).toBeNull();
  expect(status.update("thread", snapshot())).toBe("continuing");
  expect(
    status.update("thread", snapshot({ streamingMessage: fauxAssistantMessage(reasoning) })),
  ).toBe("thinking");
});

test("switching into an ongoing run with saved output shows waiting for the next response", () => {
  const status = new ThinkingStatus();
  const current = snapshot();
  current.transcript = [
    {
      id: "message",
      type: "message",
      message: { ...fauxAssistantMessage("Answer"), timestamp: 200 },
    },
  ];
  expect(status.update("thread", current)).toBe("continuing");
  expect(status.update("thread", snapshot())).toBe("continuing");
});

test("new runs and different threads reset initial waiting without reusing another run's response", () => {
  const status = new ThinkingStatus();
  status.update("first", snapshot({ streamingMessage: fauxAssistantMessage("Answer") }));
  expect(status.update("first", snapshot({ id: "next-run" }))).toBe("waiting");
  expect(status.update("second", snapshot())).toBe("waiting");
});

test("recovery, stopping and faults never show a thinking indicator", () => {
  const status = new ThinkingStatus();
  expect(status.update("thread", snapshot({ status: "aborting" }))).toBeNull();
  expect(status.update("thread", { ...snapshot(), recoveryRequired: true })).toBeNull();
  expect(status.update("thread", { ...snapshot(), faulted: true })).toBeNull();
  expect(status.update("thread", { ...snapshot(), blockedReason: "Connection lost" })).toBeNull();
  expect(status.update("thread", { ...snapshot(), operation: null })).toBeNull();
});

test("each wait measures its own duration and snapshot refreshes do not reset it", () => {
  const status = new ThinkingStatus();
  expect(status.update("thread", snapshot(), 200)).toBe("waiting");
  expect(status.startedAt).toBe(100);
  status.update("thread", snapshot(), 300);
  expect(status.startedAt).toBe(100);

  const tools = snapshot({
    runningTools: [{ toolCallId: "call", toolName: "write", args: {}, status: "running" }],
  });
  expect(status.update("thread", tools, 400)).toBeNull();
  expect(status.update("thread", snapshot(), 500)).toBe("continuing");
  expect(status.startedAt).toBe(500);
  status.update("thread", snapshot(), 900);
  expect(status.startedAt).toBe(500);

  const reasoning = snapshot({
    streamingMessage: fauxAssistantMessage({ type: "thinking", thinking: "Next step" }),
  });
  expect(status.update("thread", reasoning, 1000)).toBe("thinking");
  expect(status.startedAt).toBe(1000);
  status.update("thread", reasoning, 1100);
  expect(status.startedAt).toBe(1000);
  status.update("thread", tools, 1200);
  expect(status.update("thread", snapshot(), 1300)).toBe("continuing");
  expect(status.startedAt).toBe(1300);
});

test("retry and deferred phases override retained thinking without claiming active generation", () => {
  const status = new ThinkingStatus();
  const streamingMessage = fauxAssistantMessage({ type: "thinking", thinking: "Previous attempt" });
  expect(
    status.update(
      "thread",
      snapshot({ streamingMessage, retry: { attempt: 1, maxAttempts: 4 } }),
      200,
    ),
  ).toBe("retrying");
  expect(status.startedAt).toBe(200);
  expect(
    status.update("thread", snapshot({ streamingMessage, deferred: { pollAt: 500 } }), 300),
  ).toBe("deferred");
  expect(status.startedAt).toBe(300);
  expect(status.update("thread", snapshot({ streamingMessage }), 400)).toBe("thinking");
  expect(status.startedAt).toBe(400);
});

test("a completed tool round resets waiting even when no running-tool snapshot was delivered", () => {
  const status = new ThinkingStatus();
  const current = snapshot();
  current.transcript = [
    {
      id: "call",
      type: "message",
      message: { ...fauxAssistantMessage("Preparing files"), timestamp: 150 },
    },
    {
      id: "first-result",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "first",
        toolName: "write",
        content: [{ type: "text", text: "Done" }],
        isError: false,
        timestamp: 200,
      },
    },
  ];
  expect(status.update("thread", current, 250)).toBe("continuing");
  expect(status.startedAt).toBe(250);
  status.update("thread", current, 300);
  expect(status.startedAt).toBe(250);
  current.transcript.push({
    ...current.transcript[1]!,
    id: "next-result",
  });
  expect(status.update("thread", current, 400)).toBe("continuing");
  expect(status.startedAt).toBe(400);
});

test("completed runs clear the indicator and another thread receives its own waiting duration", () => {
  const status = new ThinkingStatus();
  status.update("first", snapshot({ retry: { attempt: 1, maxAttempts: 4 } }), 200);
  expect(status.update("first", { ...snapshot(), operation: null }, 300)).toBeNull();
  expect(status.update("first", snapshot({ id: "next", startedAt: 400 }), 450)).toBe("waiting");
  expect(status.startedAt).toBe(400);
  expect(status.update("second", snapshot({ startedAt: 500 }), 550)).toBe("waiting");
  expect(status.startedAt).toBe(500);
});

test("waiting for children takes priority over the last streamed answer and ends with the run", () => {
  const status = new ThinkingStatus();
  expect(
    status.update(
      "thread",
      snapshot({ waitingForSubagents: true, streamingMessage: fauxAssistantMessage("正在计算") }),
    ),
  ).toBe("subagents");
  expect(
    status.update("thread", snapshot({ streamingMessage: fauxAssistantMessage("13") })),
  ).toBeNull();
  expect(status.update("thread", { ...snapshot(), operation: null })).toBeNull();
});

function delegated(...states: SubagentSummary["status"][]): AgentSnapshot {
  return {
    ...snapshot(),
    operation: null,
    subagents: states.map((status, index) => ({
      path: `/worker-${index}`,
      parent: "/root",
      conversationId: index + 2,
      depth: 1,
      fork: false,
      status,
    })),
  };
}

test("an idle root shows delegated work until every child finishes without resetting the wait on updates", () => {
  const status = new ThinkingStatus();
  expect(status.update("thread", delegated("running", "queued"), 200)).toBe("subagents");
  expect(status.startedAt).toBe(200);
  const progress = delegated("running", "completed");
  progress.subagents![0]!.progress = { message: "Found a source", timestamp: 250 };
  expect(status.update("thread", progress, 300)).toBe("subagents");
  expect(status.startedAt).toBe(200);
  expect(status.update("thread", delegated("completed", "stopped", "failed"), 400)).toBeNull();
  expect(status.update("thread", delegated("queued"), 500)).toBe("subagents");
  expect(status.startedAt).toBe(500);
});

test("resuming the root response replaces delegated waiting and each thread gets its own wait", () => {
  const status = new ThinkingStatus();
  expect(status.update("first", delegated("running"), 200)).toBe("subagents");
  expect(status.update("second", delegated("running"), 300)).toBe("subagents");
  expect(status.startedAt).toBe(300);
  expect(
    status.update(
      "second",
      snapshot({
        streamingMessage: fauxAssistantMessage({
          type: "thinking",
          thinking: "Summarizing findings",
        }),
      }),
      400,
    ),
  ).toBe("thinking");
  expect(
    status.update(
      "second",
      snapshot({ streamingMessage: fauxAssistantMessage("Final summary") }),
      500,
    ),
  ).toBeNull();
  expect(status.update("second", delegated("running"), 600)).toBe("subagents");
  expect(status.startedAt).toBe(600);
});

test("paused, interrupted, blocked and faulted children never imply active background work", () => {
  const status = new ThinkingStatus();
  expect(status.update("thread", delegated("paused"))).toBeNull();
  for (const flags of [
    { recoveryRequired: true },
    { faulted: true },
    { blockedReason: "Unavailable" },
    { compacting: true },
  ]) {
    expect(status.update("thread", { ...delegated("running"), ...flags })).toBeNull();
  }
});

test("foreground waits show delegated waiting even while the subagent tool is open", () => {
  const status = new ThinkingStatus();
  expect(
    status.update(
      "thread",
      snapshot({
        waitingForSubagents: true,
        runningTools: [{ toolCallId: "spawn", toolName: "subagent", args: {}, status: "running" }],
      }),
    ),
  ).toBe("subagents");
});
