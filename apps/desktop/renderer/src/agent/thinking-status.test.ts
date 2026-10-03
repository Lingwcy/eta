import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";
import { ThinkingStatus } from "./thinking-status";

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

test("initial waiting never returns between streamed text chunks or tool rounds", () => {
  const status = new ThinkingStatus();
  expect(status.update("thread", snapshot())).toBe("waiting");
  expect(
    status.update("thread", snapshot({ streamingMessage: fauxAssistantMessage("Hello") })),
  ).toBeNull();
  expect(status.update("thread", snapshot())).toBeNull();
  expect(
    status.update(
      "thread",
      snapshot({
        runningTools: [{ toolCallId: "call", toolName: "bash", args: {}, status: "running" }],
      }),
    ),
  ).toBeNull();
  expect(status.update("thread", snapshot())).toBeNull();
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
  expect(status.update("thread", snapshot())).toBeNull();
  expect(
    status.update("thread", snapshot({ streamingMessage: fauxAssistantMessage(reasoning) })),
  ).toBe("thinking");
});

test("completed assistant output prevents a waiting marker when switching into an ongoing run", () => {
  const status = new ThinkingStatus();
  const current = snapshot();
  current.transcript = [
    {
      id: "message",
      type: "message",
      message: { ...fauxAssistantMessage("Answer"), timestamp: 200 },
    },
  ];
  expect(status.update("thread", current)).toBeNull();
  expect(status.update("thread", snapshot())).toBeNull();
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
  expect(status.update("thread", { ...snapshot(), operation: null })).toBeNull();
});
