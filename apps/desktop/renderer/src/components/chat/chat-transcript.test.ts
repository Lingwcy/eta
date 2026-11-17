// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { i18n } from "@/i18n";
import { ChatTranscript } from "./chat-transcript";

let root: Root | undefined;
const observers = new Set<{ callback: ResizeObserverCallback; elements: Set<Element> }>();
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  observers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
});

function snapshot(turns = 200): AgentSnapshot {
  const transcript: AgentSnapshot["transcript"] = [];
  for (let turn = 0; turn < turns; turn++) {
    const id = `call:${turn}`;
    transcript.push(
      {
        id: `user:${turn}`,
        type: "message",
        message: { role: "user", content: `Review run ${turn}`, timestamp: turn * 10 },
      },
      {
        id: `call:${turn}`,
        type: "message",
        message: fauxAssistantMessage(
          [
            { type: "thinking", thinking: `Checking run ${turn}\nDetailed reasoning ${turn}` },
            fauxToolCall("bash", { command: `inspect-run-${turn}` }, { id }),
          ],
          { timestamp: turn * 10 + 1 },
        ),
      },
      {
        id: `result:${turn}`,
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName: "bash",
          content: [{ type: "text", text: `Result for run ${turn}` }],
          isError: false,
          timestamp: turn * 10 + 2,
        },
      },
      {
        id: `answer:${turn}`,
        type: "message",
        message: fauxAssistantMessage(`Run ${turn} completed`, { timestamp: turn * 10 + 3 }),
      },
    );
  }
  return {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "off" },
    transcript,
    operation: null,
    lastResult: null,
    faulted: false,
  };
}

async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      elements = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {
        observers.add(this);
      }
      observe(element: Element) {
        this.elements.add(element);
      }
      unobserve(element: Element) {
        this.elements.delete(element);
      }
      disconnect() {
        this.elements.clear();
        observers.delete(this);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-index") ? 80 : 400;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    const content = this.querySelector<HTMLElement>('[style*="height:"]');
    return Math.max(400, Number.parseFloat(content?.style.height ?? "0") || 0);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return new DOMRect(0, 0, 960, this.offsetHeight);
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Math.max(
        0,
        Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight),
      );
      queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  await i18n.changeLanguage("en");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (
    value?: AgentSnapshot,
    active = true,
    submittedInputs?: readonly import("@/agent/submitted-inputs").SubmittedInput[],
  ) => {
    await act(async () =>
      root!.render(
        createElement(ChatTranscript, {
          snapshot: value,
          submittedInputs,
          running: Boolean(value?.operation),
          active,
          origins: new Map([["user:0", "Scheduled task · first run"]]),
          children: createElement("output", null, "Latest status"),
        }),
      ),
    );
    await resize();
  };
  return { container, render };
}

async function resize() {
  await act(async () => {
    for (const observer of Array.from(observers)) {
      const entries = [...observer.elements].map((target) => ({
        target,
        borderBoxSize: [{ inlineSize: 960, blockSize: (target as HTMLElement).offsetHeight }],
        contentBoxSize: [],
        devicePixelContentBoxSize: [],
        contentRect: target.getBoundingClientRect(),
      }));
      observer.callback(entries, {} as ResizeObserver);
    }
  });
}

function navigate(container: HTMLElement, turn: number) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("nav button")].find((element) =>
    element.getAttribute("aria-label")?.startsWith(`Jump to turn ${turn}:`),
  );
  expect(button).toBeDefined();
  return act(async () => button!.click());
}

test("a long restored transcript mounts a bounded window and navigates to unmounted history", async () => {
  const { container, render } = await setup();
  await render();
  await render(snapshot());
  expect(container.querySelectorAll("[data-chat-message]").length).toBeLessThan(40);
  expect(container.textContent).toContain("Run 199 completed");
  expect(container.querySelector('[data-chat-message="user:0"]')).toBeNull();
  await navigate(container, 1);
  expect(container.querySelector('[data-chat-message="user:0"]')).not.toBeNull();
  expect(container.textContent).toContain("Scheduled task · first run");
  expect(container.textContent).toContain("Checking run 0");
  expect(container.textContent).not.toContain("Result for run 199");
  expect(container.querySelectorAll("[data-chat-message]").length).toBeLessThan(40);
  await navigate(container, 200);
  expect(container.textContent).toContain("Run 199 completed");
  expect(container.querySelector('[data-chat-message="user:0"]')).toBeNull();
});

test("tool and thinking details keep their expansion after virtual rows unmount", async () => {
  const { container, render } = await setup();
  await render(snapshot());
  await navigate(container, 1);
  const firstResponse = container.querySelector<HTMLElement>('[data-index="1"]')!;
  const triggers = firstResponse.querySelectorAll<HTMLButtonElement>("button[aria-expanded]");
  expect(triggers).toHaveLength(2);
  await act(async () => {
    triggers[0]!.click();
    triggers[1]!.click();
  });
  expect(firstResponse.textContent).toContain("Detailed reasoning 0");
  expect(firstResponse.textContent).toContain("Result for run 0");
  await navigate(container, 200);
  expect(firstResponse.isConnected).toBe(false);
  await navigate(container, 1);
  const restored = container.querySelector<HTMLElement>('[data-index="1"]')!;
  expect(restored.textContent).toContain("Detailed reasoning 0");
  expect(restored.textContent).toContain("Result for run 0");
  expect(restored.querySelectorAll('[aria-expanded="true"]')).toHaveLength(2);
  await act(async () =>
    restored.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!.click(),
  );
  await navigate(container, 200);
  await navigate(container, 1);
  expect(
    container.querySelector('[data-index="1"]')!.querySelectorAll('[aria-expanded="true"]'),
  ).toHaveLength(1);
});

test("new output follows the bottom but preserves the position of someone reading history", async () => {
  const { container, render } = await setup();
  const initial = snapshot();
  await render(initial);
  const viewport = container.querySelector<HTMLElement>('[data-id$="-viewport"]')!;
  const atEnd = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  expect(atEnd()).toBeLessThanOrEqual(1);
  const response = fauxAssistantMessage("New output", { timestamp: 10000 });
  const live = {
    ...initial,
    operation: {
      id: "run",
      kind: "run" as const,
      startedAt: 10000,
      status: "running" as const,
      fromTipId: null,
      runningTools: [],
      streamingMessage: response,
    },
  };
  await render(live);
  expect(container.textContent).toContain("New output");
  expect(atEnd()).toBeLessThanOrEqual(1);
  await act(async () => {
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
  });
  const readingPosition = viewport.scrollTop;
  await render({
    ...live,
    operation: {
      ...live.operation,
      streamingMessage: {
        ...response,
        content: [{ type: "text", text: "New output keeps growing" }],
      },
    },
  });
  expect(viewport.scrollTop).toBe(readingPosition);
  expect(container.textContent).not.toContain("New output keeps growing");
  await navigate(container, 200);
  await act(async () => viewport.scrollTo({ top: viewport.scrollHeight }));
  expect(container.textContent).toContain("New output keeps growing");
  await render({
    ...initial,
    transcript: [...initial.transcript, { id: "saved", type: "message", message: response }],
  });
  expect(atEnd()).toBeLessThanOrEqual(1);
});

test("a queued user message appears below the live answer and keeps its row when placed", async () => {
  const { container, render } = await setup();
  const current = snapshot(0);
  current.operation = {
    id: "root",
    kind: "run",
    startedAt: 1,
    status: "running",
    fromTipId: null,
    runningTools: [],
    streamingMessage: fauxAssistantMessage("Working on the original request", { timestamp: 1 }),
  };
  const input = {
    requestId: "constructor",
    prompt: "Use a smaller patch",
    images: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
    mode: "steer" as const,
    submittedAt: 2,
    status: "sending" as const,
  };
  await render(current, true, [input]);
  const row = container.querySelector('[data-chat-message="input:constructor"]');
  expect(row?.textContent).toBe("Use a smaller patch");
  expect(row?.querySelector('[role="status"]')).toBeNull();
  expect(row?.querySelector("img")?.src).toBe("data:image/png;base64,AA==");
  expect(container.querySelector('[data-index="0"]')?.textContent).toContain(
    "Working on the original request",
  );
  current.queuedInputs = [
    {
      requestId: "constructor",
      operationId: "42",
      prompt: "Use a smaller patch",
      mode: "steer",
      submittedAt: 2,
      status: "queued",
      images: [{ mimeType: "image/png" }],
    },
  ];
  await render(current, true, [input]);
  expect(container.querySelector('[data-chat-message="input:constructor"]')).toBe(row);
  expect(row?.textContent).toBe("Use a smaller patch");
  expect(row?.querySelector('[role="status"]')).toBeNull();
  expect(row?.querySelector("img")?.src).toBe("data:image/png;base64,AA==");
  current.queuedInputs = [{ ...current.queuedInputs[0]!, status: "cancelled" }];
  await render(current, false, [input]);
  expect(container.querySelector('[data-chat-message="input:constructor"]')).toBe(row);
  expect(row?.querySelector("img")?.src).toBe("data:image/png;base64,AA==");
  current.queuedInputs = [];
  current.transcript.push({
    id: "42:0",
    requestId: "constructor",
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: input.prompt }, ...input.images],
      timestamp: 2,
    },
  });
  current.operation.streamingMessage = fauxAssistantMessage("Applying your smaller patch", {
    timestamp: 3,
  });
  await render(current, true, [input]);
  expect(container.querySelectorAll('[data-chat-message="input:constructor"]')).toHaveLength(1);
  expect(container.querySelector('[data-chat-message="input:constructor"]')).toBe(row);
  expect(row?.textContent).toBe("Use a smaller patch");
  expect(row?.querySelector("img")?.src).toBe("data:image/png;base64,AA==");
});

test("keeps compact spacing across thinking and tool boundaries even when a response also includes text", async () => {
  const { container, render } = await setup();
  const base: AgentSnapshot = {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "high" },
    transcript: [
      {
        id: "u1",
        type: "message",
        message: { role: "user", content: "Fix the failing tests", timestamp: 1 },
      },
      {
        id: "a1",
        type: "message",
        message: fauxAssistantMessage(
          [
            { type: "thinking", thinking: "Refining stop-handling tests" },
            fauxToolCall("codemode", { description: "Edit tests", code: "" }, { id: "c1" }),
          ],
          { timestamp: 2 },
        ),
      },
      {
        id: "r1",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "codemode",
          content: [{ type: "text", text: "ok" }],
          details: {
            calls: [
              {
                id: 1,
                name: "write",
                args: "{}",
                description: "测试失败摘要预算与原始执行证据",
                status: "ok",
              },
            ],
          },
          isError: false,
          timestamp: 3,
        },
      },
      {
        id: "a2",
        type: "message",
        message: fauxAssistantMessage(
          [
            { type: "thinking", thinking: "Testing preview error summaries" },
            { type: "text", text: "Regression verified." },
            fauxToolCall("codemode", { description: "Run tests", code: "" }, { id: "c2" }),
          ],
          { timestamp: 4 },
        ),
      },
      {
        id: "r2",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "codemode",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 5,
        },
      },
      {
        id: "a3",
        type: "message",
        message: fauxAssistantMessage(
          [
            { type: "thinking", thinking: "Refining summary defaults" },
            fauxToolCall("bash", { description: "Check diff" }, { id: "c3" }),
          ],
          { timestamp: 6 },
        ),
      },
      {
        id: "r3",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c3",
          toolName: "bash",
          content: [{ type: "text", text: "clean" }],
          isError: false,
          timestamp: 7,
        },
      },
      {
        id: "a4",
        type: "message",
        message: fauxAssistantMessage(
          [
            { type: "thinking", thinking: "Summarizing changes" },
            { type: "text", text: "All tests pass." },
          ],
          { timestamp: 8 },
        ),
      },
      {
        id: "a5",
        type: "message",
        message: fauxAssistantMessage([{ type: "thinking", thinking: "Follow-up check" }], {
          timestamp: 9,
        }),
      },
    ],
    operation: null,
    lastResult: null,
    faulted: false,
  };
  await render(base);
  const rowClass = (index: number) =>
    container.querySelector<HTMLElement>(`[data-index="${index}"]`)?.className ?? "";
  // user -> assistant activity starts with normal spacing
  expect(rowClass(1)).toContain("pt-5");
  // activity tool -> mixed [thinking, text, toolCall] stays compact at the thinking edge
  expect(rowClass(2)).toContain("pt-0.5");
  expect(rowClass(2)).not.toContain("pt-5");
  // mixed [thinking, text, toolCall] -> next activity stays compact at the trailing tool edge
  expect(rowClass(3)).toContain("pt-0.5");
  expect(rowClass(3)).not.toContain("pt-5");
  // mixed [thinking, text] (no tools) -> next thinking keeps narrative separation
  expect(rowClass(4)).toContain("pt-0.5");
  expect(rowClass(5)).toContain("pt-5");

  // Streaming a response from thinking -> thinking+text -> thinking+text+tool keeps compact top spacing
  const streamingBase: AgentSnapshot = {
    ...base,
    transcript: base.transcript.slice(0, 3),
    operation: {
      id: "run",
      kind: "run",
      startedAt: 4,
      status: "running",
      fromTipId: null,
      runningTools: [],
      streamingMessage: fauxAssistantMessage(
        [{ type: "thinking", thinking: "Testing preview error summaries" }],
        { timestamp: 4 },
      ),
    },
  };
  await render(streamingBase);
  expect(rowClass(2)).toContain("pt-0.5");
  await render({
    ...streamingBase,
    operation: {
      ...streamingBase.operation!,
      streamingMessage: fauxAssistantMessage(
        [
          { type: "thinking", thinking: "Testing preview error summaries" },
          { type: "text", text: "Regression verified." },
        ],
        { timestamp: 4 },
      ),
    },
  });
  expect(rowClass(2)).toContain("pt-0.5");
  expect(rowClass(2)).not.toContain("pt-5");

  // Text-only final answer after an activity row keeps normal separation
  await render({
    ...streamingBase,
    operation: {
      ...streamingBase.operation!,
      streamingMessage: fauxAssistantMessage("Final answer", {
        timestamp: 4,
      }),
    },
  });
  expect(rowClass(2)).toContain("pt-5");
});
