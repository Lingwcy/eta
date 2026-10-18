// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { BotSnapshot } from "../bot/contracts.ts";

vi.mock("../ui.tsx", () => ({
  colors: {
    blue: "#2563EB",
    danger: "#DC2626",
    dangerSoft: "#FEE2E2",
    border: "#E5E5E5",
    muted: "#737373",
    soft: "#F5F5F4",
    success: "#16A34A",
    surface: "#FFFFFF",
    text: "#171717",
  },
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children, style: _style, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);
  const Text = ({ children, style: _style, ...props }: Record<string, unknown>) =>
    React.createElement("span", props, children as React.ReactNode);
  const Pressable = ({ children, style: _style, onPress, ...props }: Record<string, unknown>) =>
    React.createElement(
      "button",
      { type: "button", ...props, onClick: onPress },
      children as React.ReactNode,
    );
  return {
    Pressable,
    StyleSheet: { create: (styles: unknown) => styles },
    Text,
    View,
  };
});
vi.mock("lucide-react-native", () => ({
  AlertTriangle: () => null,
  CloudOff: () => null,
  MessageSquare: () => null,
  RefreshCw: () => null,
  SlidersHorizontal: () => null,
}));

import { ChatEmptyState, PendingNotice, TaskStatus, taskTone } from "./chat-status";

let root: Root;
let container: HTMLDivElement;

function snapshot(overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    configuration: {
      model: { provider: "test-provider", modelId: "test-model" },
      thinkingLevel: "off",
    },
    transcript: [],
    operation: { id: "operation-1", status: "running", runningTools: [] },
    lastResult: null,
    faulted: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

test("task tone tracks running, waiting, failure and completion states", () => {
  expect(taskTone(undefined)).toBe("idle");
  expect(taskTone(snapshot({ operation: null, lastResult: null }))).toBe("idle");
  expect(taskTone(snapshot())).toBe("running");
  expect(
    taskTone(
      snapshot({
        operation: {
          id: "operation-1",
          status: "running",
          runningTools: [],
          waitingForApproval: true,
        },
      }),
    ),
  ).toBe("warning");
  expect(
    taskTone(
      snapshot({
        operation: null,
        lastResult: { operationId: "operation-1", status: "failed" },
      }),
    ),
  ).toBe("danger");
  expect(
    taskTone(
      snapshot({
        operation: null,
        lastResult: { operationId: "operation-1", status: "completed" },
      }),
    ),
  ).toBe("done");
  expect(taskTone(snapshot({ operation: null, faulted: true }))).toBe("danger");
});

test("task status renders its label as a live status line", async () => {
  await act(async () =>
    root.render(createElement(TaskStatus, { label: "等待审批", tone: "warning" })),
  );
  const status = container.querySelector('[role="status"]')!;
  expect(status.textContent).toContain("等待审批");
});

test("empty state keeps the title, hint and inline action in one centered column", async () => {
  await act(async () =>
    root.render(
      createElement(ChatEmptyState, {
        title: "从这里开始工作",
        hint: "任务将在 eta 中运行",
        children: createElement("button", { type: "button" }, "重新加载会话"),
      }),
    ),
  );
  expect(container.textContent).toContain("从这里开始工作");
  expect(container.textContent).toContain("任务将在 eta 中运行");
  expect(container.querySelector("button")!.textContent).toBe("重新加载会话");
});

test("pending notice keeps the prompt visible and only offers retry after sending", async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      createElement(PendingNotice, {
        sending: true,
        prompt: "继续处理这个任务",
        busy: false,
        connected: true,
        onRetry: retry,
      }),
    ),
  );
  expect(container.textContent).toContain("正在提交消息…");
  expect(container.textContent).toContain("继续处理这个任务");
  expect(container.querySelector("button")).toBeNull();

  await act(async () =>
    root.render(
      createElement(PendingNotice, {
        sending: false,
        prompt: "继续处理这个任务",
        busy: false,
        connected: false,
        onRetry: retry,
      }),
    ),
  );
  const button = container.querySelector<HTMLButtonElement>("button")!;
  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(retry).not.toHaveBeenCalled();
});
