import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "../../../../src/agent/protocol.ts";
import { getChatMessages } from "./chat-messages";

const message = { ...fauxAssistantMessage("Hello"), timestamp: 100 };
function snapshot(): AgentSnapshot {
  return {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "high" },
    transcript: [],
    operation: {
      id: "run",
      kind: "run",
      startedAt: 50,
      status: "running",
      fromTipId: null,
      runningTools: [],
      streamingMessage: message,
    },
    lastResult: null,
    faulted: false,
  };
}

test("streaming response keeps its identity when saved without appearing twice", () => {
  const current = snapshot();
  const live = getChatMessages(current);
  current.transcript = [{ id: "saved", type: "message", message }];
  const saving = getChatMessages(current);
  expect(saving).toHaveLength(1);
  expect(saving[0]?.id).toBe(live[0]?.id);
  current.operation = null;
  expect(getChatMessages(current)[0]?.id).toBe(live[0]?.id);
});

test("later tool rounds append a new response while preserving earlier responses", () => {
  const current = snapshot();
  const first = getChatMessages(current)[0]?.id;
  current.transcript = [{ id: "saved", type: "message", message }];
  if (current.operation) current.operation.streamingMessage = { ...message, timestamp: 200 };
  const entries = getChatMessages(current);
  expect(entries).toHaveLength(2);
  expect(entries[0]?.id).toBe(first);
  expect(entries[1]?.id).not.toBe(first);
});

test("assistant messages sharing a timestamp still have distinct stable identities", () => {
  const current = snapshot();
  current.operation = null;
  current.transcript = [
    { id: "first", type: "message", message },
    {
      id: "second",
      type: "message",
      message: { ...message, content: [{ type: "text", text: "Next" }] },
    },
  ];
  const entries = getChatMessages(current);
  expect(new Set(entries.map(({ id }) => id)).size).toBe(2);
});
