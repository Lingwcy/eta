// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { i18n } from "@/i18n";
import { RunningAnimation, RunningIndicator } from "./running-indicator";
import { Sheet } from "./sheet";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { TabIcon } from "../tabs/tab-icon";
import { ThreadLoading } from "../chat/thread-loading";
import { ActionToolbar } from "../input/action-toolbar";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("RunningIndicator spins when visible and pauses when RunningAnimation is false", async () => {
  await act(async () =>
    root.render(
      createElement(RunningAnimation.Provider, { value: true }, createElement(RunningIndicator)),
    ),
  );
  expect(container.querySelector(".animate-spin")).not.toBeNull();
  await act(async () =>
    root.render(
      createElement(RunningAnimation.Provider, { value: false }, createElement(RunningIndicator)),
    ),
  );
  expect(container.querySelector(".animate-spin")).toBeNull();
});

test("TabIcon renders pulsing indicator for running tabs and static icon otherwise", async () => {
  await act(async () =>
    root.render(
      createElement(TabIcon, {
        item: {
          id: "t1",
          kind: "conversation",
          title: "Chat",
          subtitle: "",
          text: "",
          running: true,
        },
      }),
    ),
  );
  const runningLabel = container.querySelector('[aria-label="Running"]');
  expect(runningLabel).not.toBeNull();
  expect(runningLabel?.querySelector('[class*="eta-pulse-ring"]')).not.toBeNull();

  await act(async () =>
    root.render(
      createElement(TabIcon, {
        item: {
          id: "t1",
          kind: "conversation",
          title: "Chat",
          subtitle: "",
          text: "",
          running: false,
        },
      }),
    ),
  );
  expect(container.querySelector('[aria-label="Running"]')).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

test("ThreadLoading displays breathing skeleton bars while loading", async () => {
  await act(async () =>
    root.render(createElement(ThreadLoading, { loading: true, onRetry: () => {} })),
  );
  expect(container.querySelectorAll('[class*="eta-breathe"]').length).toBe(3);
  await act(async () =>
    root.render(createElement(ThreadLoading, { loading: false, onRetry: () => {} })),
  );
  expect(container.querySelectorAll('[class*="eta-breathe"]').length).toBe(0);
});

test("ActionToolbar triggers send nudge on submit and toggles to stop button", async () => {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  await act(async () =>
    root.render(
      createElement(ActionToolbar, {
        canSubmit: true,
        hasContent: true,
        onSubmit,
        onStop,
      }),
    ),
  );
  const sendButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Send message"]',
  )!;
  expect(sendButton).not.toBeNull();
  await act(async () => sendButton.click());
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(sendButton.querySelector('[class*="eta-send-nudge"]')).not.toBeNull();

  await act(async () =>
    root.render(
      createElement(ActionToolbar, {
        canSubmit: false,
        hasContent: false,
        isRunning: true,
        onSubmit,
        onStop,
      }),
    ),
  );
  const stopButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Stop generation"]',
  )!;
  expect(stopButton).not.toBeNull();
  await act(async () => stopButton.click());
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("Sheet and ContextMenu open and render popup transitions without context errors", async () => {
  await act(async () =>
    root.render(
      createElement(
        "div",
        null,
        createElement(Sheet, {
          open: true,
          onOpenChange: () => {},
          title: "Details",
          children: createElement("p", null, "Sheet body"),
        }),
        createElement(
          ContextMenu,
          { open: true },
          createElement(ContextMenuTrigger, null, "Target"),
          createElement(ContextMenuContent, null, createElement(ContextMenuItem, null, "Action")),
        ),
      ),
    ),
  );
  expect(document.body.textContent).toContain("Sheet body");
  expect(document.body.textContent).toContain("Action");
});
