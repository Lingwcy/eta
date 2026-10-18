// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { BotMessage, BotSnapshot } from "../bot/contracts.ts";
import { thread } from "../bot/fixtures.test-support.ts";

vi.mock("../ui.tsx", async () => {
  const React = await import("react");
  return {
    ScrollArea: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", {}, children),
    colors: {},
  };
});
vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children);
  return {
    View,
    Text: View,
    Image: () => null,
    Linking: { openURL: vi.fn() },
    Platform: { OS: "web" },
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityState,
    }: {
      children?: React.ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "aria-expanded": accessibilityState?.expanded,
        },
        children,
      ),
  };
});
vi.mock("react-native-markdown-display", async () => {
  const React = await import("react");
  return {
    default: ({ children }: { children: React.ReactNode }) =>
      React.createElement("p", {}, children),
  };
});
vi.mock("lucide-react-native", () => ({
  Brain: () => null,
  CircleX: () => null,
  FileCode2: () => null,
  FilePenLine: () => null,
  FileText: () => null,
  Globe: () => null,
  Search: () => null,
  Terminal: () => null,
  Wrench: () => null,
}));

import { MessageView } from "./message.tsx";
import { buildToolIndex } from "../conversation.ts";

let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function assistant(name = "read"): BotMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name, arguments: { path: "original.txt" } }],
  };
}

function snapshot(message: BotMessage, overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    ...thread.snapshot,
    transcript: [{ id: "assistant", message }],
    ...overrides,
  };
}

async function renderMessage(message: BotMessage, value: BotSnapshot) {
  await act(async () =>
    root.render(
      createElement(MessageView, { message, snapshot: value, tools: buildToolIndex(value) }),
    ),
  );
}

function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((element) =>
    element.getAttribute("aria-label")?.includes(text),
  );
  expect(found, "Expected tool card containing " + text).toBeDefined();
  return found!;
}

async function press(element: HTMLButtonElement) {
  await act(async () => element.click());
}

test("a live status overrides saved stopped state while expanded results refresh on a new snapshot", async () => {
  const message = assistant();
  const result: BotMessage = {
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    content: [{ type: "text", text: "Saved output" }],
  };
  const value = snapshot(message, {
    transcript: [
      { id: "assistant", message, toolStatus: "stopped" },
      { id: "result", message: result },
    ],
    operation: {
      id: "operation",
      status: "running",
      runningTools: [
        {
          toolCallId: "call",
          toolName: "read",
          args: {},
          status: "running",
          description: "Read the original file",
        },
      ],
    },
  });
  await renderMessage(message, value);
  const disclosure = button("Read the original file，执行中");
  expect(document.body.textContent).not.toContain("Saved output");
  await press(disclosure);
  expect(document.body.textContent).toContain('"path": "original.txt"');
  expect(document.body.textContent).toContain("Saved output");

  await renderMessage(message, {
    ...value,
    transcript: [
      { id: "assistant", message },
      {
        id: "result",
        message: { ...result, content: [{ type: "text", text: "Current failure" }], isError: true },
      },
    ],
    operation: null,
  });
  expect(button("执行失败").getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent).toContain("Current failure");
  expect(document.body.textContent).not.toContain("Saved output");
  expect(document.body.textContent).not.toContain("执行中");
  await press(button("执行失败"));
  expect(document.body.textContent).not.toContain("Current failure");
});

test("saved stopped calls remain stopped and only the current streaming call is generating", async () => {
  const message = assistant();
  await renderMessage(
    message,
    snapshot(message, {
      transcript: [{ id: "assistant", message, toolStatus: "stopped" }],
    }),
  );
  expect(button("已停止")).toBeDefined();

  await renderMessage(
    message,
    snapshot(message, {
      operation: { id: "operation", status: "running", runningTools: [] },
    }),
  );
  expect(button("未完成")).toBeDefined();

  await renderMessage(
    message,
    snapshot(message, {
      transcript: [],
      operation: {
        id: "operation",
        status: "running",
        runningTools: [],
        streamingMessage: message,
      },
    }),
  );
  expect(button("准备执行")).toBeDefined();
});

test("nested live previews replace saved children and a waiting outer call remains actionable", async () => {
  const message = assistant("codemode");
  const value = snapshot(message, {
    transcript: [
      { id: "assistant", message },
      {
        id: "result",
        message: {
          role: "toolResult",
          toolCallId: "call",
          toolName: "codemode",
          content: [],
          details: {
            calls: [
              {
                id: 1,
                name: "read",
                args: "old arguments",
                status: "ok",
                result: { content: [{ type: "text", text: "Old nested output" }] },
              },
            ],
          },
        },
      },
    ],
  });
  await renderMessage(message, value);
  expect(document.querySelectorAll("button")).toHaveLength(1);
  await press(button("read"));
  expect(document.body.textContent).toContain("old arguments");
  expect(document.body.textContent).toContain("Old nested output");

  await renderMessage(message, {
    ...value,
    operation: {
      id: "operation",
      status: "running",
      runningTools: [
        { toolCallId: "call", toolName: "codemode", args: {}, status: "waiting" },
        {
          toolCallId: "call/c1",
          parentToolCallId: "call",
          toolName: "write",
          args: { path: "new.txt" },
          status: "running",
          description: "Update nested file",
          result: { content: [{ type: "text", text: "New nested output" }] },
        },
      ],
    },
  });
  expect(document.querySelectorAll("button")).toHaveLength(2);
  expect(button("codemode · original.txt，等待批准")).toBeDefined();
  expect(button("Update nested file，执行中").getAttribute("aria-expanded")).toBe("true");
  expect(document.body.textContent).toContain('"path": "new.txt"');
  expect(document.body.textContent).toContain("New nested output");
  expect(document.body.textContent).not.toContain("Old nested output");
});
