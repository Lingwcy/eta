// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { i18n } from "@/i18n";
import { ChatMessage } from "./chat-message";
import { getChatMessages } from "./chat-messages";
import { ThinkingMessage } from "./thinking-message";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  vi.unstubAllGlobals();
});

async function setup() {
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
  return container;
}

test("thinking starts as its first line and preserves expanded details across streaming and saving", async () => {
  const container = await setup();
  const text = "Check the concurrency configuration\nInspect worker capacity and checkout locks";
  const message = fauxAssistantMessage([{ type: "thinking", thinking: text }], {
    stopReason: "pending",
  });
  const snapshot: AgentSnapshot = {
    configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
    transcript: [],
    operation: {
      id: "run",
      kind: "run",
      startedAt: 1,
      fromTipId: null,
      status: "running",
      runningTools: [],
      streamingMessage: message,
    },
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
            streaming: entry.streaming,
            tools: [],
            animate: false,
          }),
        ),
      ),
    );
  await render();
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).toContain("Check the concurrency configuration");
  expect(container.textContent).not.toContain("Inspect worker capacity");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  await act(async () => trigger.click());
  const viewport = container.querySelector<HTMLElement>('[role="region"]')!;
  expect(viewport.textContent).toContain(text);
  expect(trigger.textContent).not.toContain("Check the concurrency configuration");
  expect(container.textContent!.split("Check the concurrency configuration")).toHaveLength(2);
  await act(async () => {
    viewport.scrollTop = 120;
    viewport.dispatchEvent(new Event("scroll"));
  });
  const updated = {
    ...message,
    content: [{ type: "thinking" as const, thinking: text + "\nLocated the reservation owner" }],
  };
  snapshot.operation!.streamingMessage = updated;
  await render();
  expect(container.querySelector('[role="region"]')).toBe(viewport);
  expect(viewport.textContent).toContain("Located the reservation owner");
  expect(viewport.scrollTop).toBe(120);
  snapshot.transcript = [
    { id: "saved", type: "message", message: { ...updated, stopReason: "stop" } },
  ];
  snapshot.operation = null;
  await render();
  expect(container.querySelector("button[aria-expanded]")).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('[role="region"]')).toBe(viewport);
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => trigger.click());
  expect(container.querySelector('[role="region"]')!.textContent).toContain(
    "Located the reservation owner",
  );
});

test.each(["\n\r\nFirst line\r\nSecond line", "\rFirst line\rSecond line"])(
  "collapsed thinking skips leading blank lines (%s)",
  async (text) => {
    const container = await setup();
    await act(async () => root!.render(createElement(ThinkingMessage, { text, active: false })));
    expect(container.textContent).toBe("First line");
    const trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => trigger.click());
    expect(container.querySelector('[role="region"]')!.textContent).toContain("Second line");
  },
);

test("a single long thinking line remains fully readable once expanded without repeating the preview", async () => {
  const container = await setup();
  const text = "Long single-line thinking ".repeat(30) + "final words";
  await act(async () => root!.render(createElement(ThinkingMessage, { text, active: false })));
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(trigger.textContent).toBe(text);
  await act(async () => trigger.click());
  expect(trigger.textContent).toBe("Thinking content");
  expect(container.querySelector('[role="region"]')!.textContent).toBe(text);
});
