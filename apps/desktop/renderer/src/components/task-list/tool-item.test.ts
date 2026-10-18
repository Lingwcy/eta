// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { i18n } from "@/i18n";
import { getTools, indexTools, toolsForMessage } from "@/agent/selectors";
import { getChatMessages } from "../chat/chat-messages";
import { ChatMessage } from "../chat/chat-message";
import { TaskList } from "./index";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
});

test.each([false, true])(
  "a compact streamed row keeps its expansion through saving, execution and completion (error: %s)",
  async (isError) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    await i18n.changeLanguage("en");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const message = fauxAssistantMessage(
      fauxToolCall(
        "bash",
        { description: "Check task configuration", command: "git status" },
        { id: "call" },
      ),
      { stopReason: "pending" },
    );
    const snapshot: AgentSnapshot = {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [],
      operation: {
        id: "run",
        kind: "run",
        startedAt: 1,
        status: "running",
        fromTipId: null,
        runningTools: [],
        streamingMessage: message,
      },
      toolIntents: { call: "Check task configuration" },
      lastResult: null,
      faulted: false,
    };
    const render = async () =>
      act(async () =>
        root!.render(
          getChatMessages(snapshot).map((entry) =>
            createElement(ChatMessage, {
              key: entry.id,
              message: entry.message,
              tools: toolsForMessage(
                indexTools(getTools(snapshot)),
                message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : [])),
              ),
              streaming: entry.streaming,
              animate: false,
            }),
          ),
        ),
      );
    const intents = snapshot.toolIntents;
    delete snapshot.toolIntents;
    await render();
    expect(container.textContent).toContain("Preparing bash");
    snapshot.toolIntents = intents;
    await render();
    const trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(trigger.textContent).toContain("Check task configuration");
    expect(trigger.title).toBe("Preparing bash");
    expect(container.textContent).not.toContain("git status");
    await act(async () => trigger.click());
    expect(container.textContent).toContain("git status");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
    expect(viewport).not.toBeNull();
    await act(async () => {
      viewport.scrollTop = 80;
      viewport.dispatchEvent(new Event("scroll"));
    });
    snapshot.transcript = [{ id: "saved", type: "message", message }];
    snapshot.operation!.runningTools = [
      {
        toolCallId: "call",
        toolName: "bash",
        args: message.content[0]!.type === "toolCall" ? message.content[0]!.arguments : {},
        status: "running",
      },
    ];
    await render();
    expect(container.querySelector("button[aria-expanded]")).toBe(trigger);
    expect(container.querySelector('[role="region"]')).toBe(viewport);
    expect(viewport.scrollTop).toBe(80);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("git status");
    snapshot.operation!.runningTools[0]!.status = "waiting";
    await render();
    expect(container.textContent).toContain("Awaiting approval");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    snapshot.transcript.push({
      id: "result",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        content: [{ type: "text", text: isError ? "Permission denied" : "working tree clean" }],
        isError,
        timestamp: 2,
      },
    });
    snapshot.operation = null;
    await render();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain(isError ? "Permission denied" : "working tree clean");
    expect(viewport.scrollTop).toBe(80);
    expect(viewport.textContent).toContain(isError ? "Permission denied" : "working tree clean");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[class*="animate-spin"]')).toBeNull();
  },
);

test("Code mode lists individual calls directly and keeps script failures inspectable", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const script = {
    toolCallId: "script",
    toolName: "codemode",
    description: "Overall script summary",
    args: { code: "await tools.read({path:'a.txt'})" },
    status: "settled" as const,
  };
  const read = {
    toolCallId: "script/c1",
    parentToolCallId: "script",
    toolName: "read",
    description: "Read configuration",
    args: { path: "a.txt" },
    status: "settled" as const,
    result: { content: [{ type: "text" as const, text: "line\n".repeat(200) + "Last line" }] },
  };
  await act(async () => root!.render(createElement(TaskList, { tools: [script, read] })));
  expect(container.textContent).not.toContain("Overall script summary");
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(trigger.textContent).toBe("Read configuration");
  await act(async () => trigger.click());
  const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
  expect(viewport.textContent).toContain("Last line");
  await act(async () =>
    root!.render(
      createElement(TaskList, {
        tools: [
          {
            ...script,
            isError: true,
            result: { content: [{ type: "text", text: "Script failed after reading" }] },
          },
          read,
        ],
      }),
    ),
  );
  expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(2);
  expect(container.textContent).toContain("Overall script summary");
  expect(container.querySelectorAll("button[aria-expanded]")[1]).toBe(trigger);
  expect(viewport.textContent).toContain("Last line");
});
