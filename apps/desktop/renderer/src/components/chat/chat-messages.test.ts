import { expect, test } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { getChatMessages, isActivityMessage } from "./chat-messages";

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
  expect(live[0]?.streaming).toBe(true);
  current.transcript = [{ id: "saved", type: "message", message }];
  const saving = getChatMessages(current);
  expect(saving).toHaveLength(1);
  expect(saving[0]?.id).toBe(live[0]?.id);
  expect(saving[0]?.streaming).toBe(false);
  current.operation = null;
  expect(getChatMessages(current)[0]?.id).toBe(live[0]?.id);
});

test("an older assistant with the same metadata does not hide a later turn's stream", () => {
  const value = snapshot();
  const previous = { ...message, content: [{ type: "text" as const, text: "Earlier answer" }] };
  const user = { role: "user" as const, content: "Next question", timestamp: 100 };
  value.transcript = [
    { id: "old", type: "message", message: previous },
    { id: "user", type: "message", message: user },
  ];
  const rows = getChatMessages(value);
  expect(rows.map(({ message }) => message)).toEqual([previous, user, message]);
  const id = rows.at(-1)?.id;
  value.transcript.push({ id: "saved", type: "message", message });
  const saved = getChatMessages(value);
  expect(saved).toHaveLength(3);
  expect(saved.at(-1)?.id).toBe(id);
  expect(new Set(saved.map(({ id }) => id)).size).toBe(3);
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
  expect(entries.map(({ streaming }) => streaming)).toEqual([false, true]);
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

test("thinking-only output retains its content and identity through streaming, saving and reopening", () => {
  const current = snapshot();
  const thought = {
    ...message,
    content: [{ type: "thinking" as const, thinking: "First thought" }],
  };
  current.operation!.streamingMessage = thought;
  const first = getChatMessages(current)[0]!;
  expect(first.message.content).toEqual(thought.content);
  expect(first.streaming).toBe(true);

  const updated = {
    ...thought,
    content: [{ type: "thinking" as const, thinking: "First thought\nNext thought" }],
  };
  current.operation!.streamingMessage = updated;
  const next = getChatMessages(current)[0]!;
  expect(next.id).toBe(first.id);
  expect(next.message.content).toEqual(updated.content);

  current.transcript = [{ id: "saved", type: "message", message: updated }];
  current.operation = null;
  const reopened = getChatMessages(current)[0]!;
  expect(reopened.id).toBe(first.id);
  expect(reopened.message.content).toEqual(updated.content);
  expect(reopened.streaming).toBe(false);
});

test("stopping a run clears live thinking even when the only message was an unsaved partial", () => {
  const current = snapshot();
  current.operation!.streamingMessage = {
    ...message,
    content: [{ type: "thinking", thinking: "Partial thought" }],
  };
  expect(getChatMessages(current)[0]?.streaming).toBe(true);
  current.operation = null;
  expect(getChatMessages(current)).toEqual([]);
});

test.each(["aborting", "recovery", "fault", "retry", "deferred"] as const)(
  "%s keeps partial thinking visible without marking it as streaming",
  (phase) => {
    const current = snapshot();
    const thought = {
      ...message,
      content: [{ type: "thinking" as const, thinking: "Partial thought" }],
    };
    current.operation!.streamingMessage = thought;
    if (phase === "aborting") current.operation!.status = "aborting";
    if (phase === "recovery") current.recoveryRequired = true;
    if (phase === "fault") current.faulted = true;
    if (phase === "retry") current.operation!.retry = { attempt: 1, maxAttempts: 4 };
    if (phase === "deferred") current.operation!.deferred = { pollAt: 500 };
    const entry = getChatMessages(current)[0]!;
    expect(entry.message.content).toEqual(thought.content);
    expect(entry.streaming).toBe(false);
  },
);

test("compact activity sequences stop at narrative, images and user turns", () => {
  const thinking = { type: "thinking" as const, thinking: "Inspect concurrency" };
  const call = fauxToolCall("read", { path: "config.ts" });
  expect(isActivityMessage(fauxAssistantMessage([thinking, call]))).toBe(true);
  expect(isActivityMessage(fauxAssistantMessage([call]))).toBe(true);
  expect(
    isActivityMessage(
      fauxAssistantMessage([thinking, { type: "text", text: "Here are the results" }]),
    ),
  ).toBe(false);
  expect(isActivityMessage(fauxAssistantMessage([]))).toBe(false);
  expect(
    isActivityMessage({
      role: "user",
      timestamp: 1,
      content: [{ type: "image", data: "test", mimeType: "image/png" }],
    }),
  ).toBe(false);
  expect(isActivityMessage({ role: "user", content: "Next task", timestamp: 1 })).toBe(false);
});

test("invisible assistant entries do not create empty transcript spacing", () => {
  const value = snapshot();
  value.operation = null;
  value.transcript = [
    { id: "empty", type: "message", message: fauxAssistantMessage([]) },
    {
      id: "blank",
      type: "message",
      message: fauxAssistantMessage([{ type: "thinking", thinking: "  " }]),
    },
    { id: "visible", type: "message", message: fauxAssistantMessage("Visible reply") },
  ];
  expect(getChatMessages(value).map(({ message }) => message.content)).toEqual([
    fauxAssistantMessage("Visible reply").content,
  ]);
});
