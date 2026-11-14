// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { BotSnapshot } from "../bot/contracts.ts";

const mocks = vi.hoisted(() => ({
  useMobile: vi.fn(),
  useAction: vi.fn(),
}));

vi.mock("../provider.tsx", () => ({ useMobile: mocks.useMobile }));
vi.mock("../ui.tsx", async () => {
  const React = await import("react");
  return {
    Button: ({
      children,
      disabled,
      onPress,
    }: {
      children: React.ReactNode;
      disabled?: boolean;
      onPress: () => void;
    }) => React.createElement("button", { type: "button", disabled, onClick: onPress }, children),
    ScrollArea: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "scroll-area" }, children),
    colors: { muted: "#777" },
    common: { row: {} },
    useAction: mocks.useAction,
  };
});
vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children, style: _style, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);
  const Text = ({
    children,
    style: _style,
    numberOfLines: _numberOfLines,
    selectable: _selectable,
    ...props
  }: Record<string, unknown>) => React.createElement("span", props, children as React.ReactNode);
  const Pressable = ({
    children,
    style: _style,
    onPress,
    accessibilityRole,
    accessibilityState,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        type: "button",
        ...props,
        role: accessibilityRole,
        "aria-expanded":
          (accessibilityState as { expanded?: boolean } | undefined)?.expanded ?? undefined,
        onClick: onPress,
      },
      children as React.ReactNode,
    );
  return {
    Platform: { OS: "web" },
    Pressable,
    StyleSheet: { create: (styles: unknown) => styles },
    Text,
    View,
  };
});
vi.mock("lucide-react-native", () => ({
  Bot: () => null,
  ChevronRight: () => null,
  ShieldQuestion: () => null,
}));

import { Approvals } from "./approvals";

let root: Root;

function approval(
  overrides: Partial<NonNullable<BotSnapshot["approvals"]>[number]> = {},
): NonNullable<BotSnapshot["approvals"]>[number] {
  return {
    id: "approval-1",
    tool: "write",
    args: { path: "src/secret.txt", content: "Native scheduled work" },
    reason: "The task needs to update a source file.",
    status: "pending",
    networkAccess: false,
    readableRoots: [],
    writableRoots: ["/workspace/project"],
    reusable: true,
    gitMetadata: {
      commonDir: "/workspace/project/.git",
      worktreeDir: "/workspace/project",
      branch: "main",
    },
    review: {
      status: "escalated",
      risk: "high",
      rationale: "Check this write before it runs.",
      reviewer: { provider: "test-provider", modelId: "test-reviewer" },
      toolCalls: [{ tool: "read", summary: "Read package metadata" }],
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    configuration: {
      model: { provider: "test-provider", modelId: "test-model" },
      thinkingLevel: "off",
    },
    transcript: [],
    operation: { id: "operation-1", status: "running", runningTools: [] },
    lastResult: null,
    approvals: [approval()],
    approvalHistory: [],
    faulted: false,
    ...overrides,
  };
}

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

async function renderApprovals(
  value: BotSnapshot,
  options: {
    connected?: boolean;
    busy?: boolean;
    approve?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const approve = options.approve ?? vi.fn();
  mocks.useMobile.mockReturnValue({
    state: { status: options.connected === false ? "disconnected" : "connected" },
    store: { approve },
  });
  mocks.useAction.mockReturnValue({
    busy: options.busy ?? false,
    run: (action: () => unknown) => action(),
  });
  await act(async () => root.render(createElement(Approvals, { snapshot: value })));
  return approve;
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  )!;
}

function buttonContaining(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) =>
    element.textContent?.includes(text),
  )!;
}

async function press(target: HTMLButtonElement) {
  await act(async () => target.click());
}

test("pending approval keeps its reason and scope visible while details and arguments default collapsed", async () => {
  await renderApprovals(snapshot());
  expect(document.body.textContent).toContain("The task needs to update a source file.");
  expect(document.body.textContent).toContain("Write scope: /workspace/project");
  expect(document.body.textContent).not.toContain('"path"');
  expect(document.body.textContent).not.toContain("/workspace/project/.git");

  const disclosure = button("Permissions & arguments");
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  await press(disclosure);
  expect(document.body.textContent).toContain("Git metadata: branch main");
  expect(document.body.textContent).toContain("Review note: Check this write before it runs.");
  expect(document.body.textContent).toContain("Reviewer model: test-provider/test-reviewer");
  expect(document.body.textContent).toContain("Read package metadata");
  expect(document.body.textContent).toContain('"path": "src/secret.txt"');
  expect(button("Hide details").getAttribute("aria-expanded")).toBe("true");

  await press(button("Hide details"));
  expect(document.body.textContent).not.toContain('"path"');
  expect(button("Permissions & arguments").getAttribute("aria-expanded")).toBe("false");
});

test("deny, approve-once and reusable Git approval pass exact decisions; reuse is conditional", async () => {
  const approve = vi.fn();
  await renderApprovals(snapshot(), { approve });
  await press(button("Deny"));
  await press(button("Allow once"));
  await press(button("Allow this Git scope for current run"));
  expect(approve.mock.calls).toEqual([
    ["approval-1", false, undefined],
    ["approval-1", true, undefined],
    ["approval-1", true, "run"],
  ]);

  await renderApprovals(snapshot({ approvals: [approval({ reusable: false })] }), { approve });
  expect(
    [...document.querySelectorAll("button")].some((element) =>
      element.textContent?.includes("Allow this Git scope for current run"),
    ),
  ).toBe(false);
});

test("approval actions are disabled while busy or disconnected", async () => {
  await renderApprovals(snapshot(), { busy: true });
  for (const label of ["Deny", "Allow once", "Allow this Git scope for current run"])
    expect(button(label).disabled).toBe(true);

  const approve = vi.fn();
  await renderApprovals(snapshot(), { connected: false, approve });
  for (const label of ["Deny", "Allow once", "Allow this Git scope for current run"])
    expect(button(label).disabled).toBe(true);
  await press(button("Allow once"));
  expect(approve).not.toHaveBeenCalled();
});

test("history appears only during an operation, keeps the newest 20 collapsed, and resets row details when collapsed", async () => {
  const entries = Array.from({ length: 25 }, (_, index) =>
    approval({
      id: `history-${index}`,
      tool: `tool-${index}`,
      status: index === 5 ? "denied" : "approved",
      decidedBy: index === 7 ? "reuse" : "auto",
      gitMetadata: undefined,
      readableRoots: [],
      writableRoots: [],
      review: {
        status: "complete",
        rationale: index === 24 ? "Latest review rationale" : undefined,
        reviewer: { provider: "history-provider", modelId: "history-reviewer" },
      },
    }),
  );
  const withHistory = snapshot({ approvals: [], approvalHistory: entries });
  await renderApprovals(snapshot({ operation: null, approvals: [], approvalHistory: entries }));
  expect(document.body.textContent).not.toContain("Auto-review history");

  await renderApprovals(withHistory);
  const header = button("Auto-review history (20)");
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(document.body.textContent).not.toContain("tool-24");

  await press(header);
  expect(document.body.textContent).toContain("Approved for this run · tool-7");
  expect(document.body.textContent).toContain("Auto-approved · tool-6");
  expect(document.body.textContent).toContain("Auto-denied · tool-5");
  expect(document.body.textContent).toContain("tool-24");
  expect(document.body.textContent).not.toContain("tool-4");
  expect(document.body.textContent).not.toContain(
    "Reviewer model: history-provider/history-reviewer",
  );

  const latest = buttonContaining("tool-24");
  expect(latest.getAttribute("aria-expanded")).toBe("false");
  await press(latest);
  expect(document.body.textContent).toContain("Reviewer model: history-provider/history-reviewer");

  await press(button("Auto-review history (20)"));
  expect(button("Auto-review history (20)").getAttribute("aria-expanded")).toBe("false");
  await press(button("Auto-review history (20)"));
  expect(document.body.textContent).not.toContain(
    "Reviewer model: history-provider/history-reviewer",
  );
});
