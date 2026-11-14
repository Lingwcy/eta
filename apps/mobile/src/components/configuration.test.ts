// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Configuration } from "../bot/contracts.ts";

const mocks = vi.hoisted(() => ({
  useMobile: vi.fn(),
  configure: vi.fn(),
}));

vi.mock("../provider.tsx", () => ({ useMobile: mocks.useMobile }));
vi.mock("../ui.tsx", () => ({
  colors: {
    border: "#e4e4e7",
    borderSubtle: "#f4f4f5",
    ink: "#09090b",
    muted: "#777",
    secondary: "#52525b",
    soft: "#f4f4f5",
    surface: "#ffffff",
    text: "#000",
  },
  useAction: () => ({
    busy: false,
    run: async (action: () => Promise<void>) => {
      await action();
    },
  }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-svg", () => ({
  SvgXml: ({ xml }: { xml: string }) =>
    createElement("span", { "data-testid": "provider-svg", "data-xml": xml }),
}));
vi.mock("lucide-react-native", () => ({
  Bot: () => createElement("span", { "data-testid": "fallback-bot" }),
  Check: () => null,
  LayoutGrid: () => null,
  Search: () => null,
  Shield: () => null,
  X: () => null,
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children, style: _style, ...props }: Record<string, unknown>) =>
    React.createElement("div", props, children as React.ReactNode);
  const Text = ({ children, style: _style, ...props }: Record<string, unknown>) =>
    React.createElement("span", props, children as React.ReactNode);
  const TextInput = ({ style: _style, ...props }: Record<string, unknown>) =>
    React.createElement("input", props);
  const Pressable = ({
    children,
    onPress,
    accessibilityRole,
    accessibilityState,
    accessibilityLabel,
    style: _style,
    hitSlop: _hitSlop,
    ...props
  }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        type: "button",
        ...props,
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-selected": (accessibilityState as { selected?: boolean } | undefined)?.selected,
        onClick: onPress,
      },
      children as React.ReactNode,
    );
  const Animated = {
    Value: class {
      value: number;
      constructor(value: number) {
        this.value = value;
      }
    },
    View,
    timing: () => ({ start: (callback?: () => void) => callback?.() }),
    parallel: () => ({ start: (callback?: () => void) => callback?.() }),
  };
  return {
    Animated,
    Easing: { in: () => () => 0, out: () => () => 0, cubic: () => 0 },
    Image: View,
    KeyboardAvoidingView: View,
    Modal: ({ children, visible }: { children?: React.ReactNode; visible?: boolean }) =>
      visible === false ? null : React.createElement("div", {}, children),
    Platform: {
      OS: "web",
      select: (values: Record<string, unknown>) => values.default ?? values.web,
    },
    Pressable,
    ScrollView: View,
    StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {}, hairlineWidth: 1 },
    Text,
    TextInput,
    View,
  };
});

import { ConfigurationSheet } from "./configuration";

const opened: Configuration = {
  provider: "p",
  modelId: "one",
  thinkingLevel: "off",
  sandboxMode: "read-only",
};
const models = [
  { provider: "p", id: "one", name: "One", thinkingLevels: ["off", "high"] },
  { provider: "p", id: "two", name: "Two", thinkingLevels: ["off", "high"] },
];
let root: Root;
let latest: Configuration;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  latest = { ...opened, modelId: "two", thinkingLevel: "high" };
  mocks.configure.mockReset();
  mocks.useMobile.mockReturnValue({
    state: {
      configuration: latest,
      library: { models, workspaces: [], projects: [], threads: [], settings: {} },
      thread: {
        id: "thread",
        snapshot: {
          sandbox: {
            mode: "read-only",
            available: true,
            allowedModes: ["read-only", "workspace-write"],
          },
        },
      },
    },
    store: { configure: mocks.configure },
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function labelled(label: string) {
  const element = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error("Missing control " + label);
  return element as HTMLButtonElement;
}
async function open() {
  await act(async () =>
    root.render(createElement(ConfigurationSheet, { configuration: opened, onClose: () => {} })),
  );
}

test("applying a sandbox change keeps the model that changed while the sheet was open", async () => {
  await open();
  await act(async () => labelled("Sandbox policy: Read-only, tap to switch").click());
  await act(async () => labelled("Apply settings").click());
  expect(mocks.configure).toHaveBeenCalledWith({
    provider: "p",
    modelId: "two",
    thinkingLevel: "high",
    sandboxMode: "workspace-write",
  });
});

test("applying without edits sends the live configuration unchanged", async () => {
  await open();
  await act(async () => labelled("Apply settings").click());
  expect(mocks.configure).toHaveBeenCalledWith(latest);
});

test("renders provider icons in the split rail and filters visible models by provider tab", async () => {
  const multiConfig: Configuration = {
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "off",
    sandboxMode: "read-only",
  };
  mocks.useMobile.mockReturnValue({
    state: {
      configuration: multiConfig,
      library: {
        models: [
          { provider: "openai", id: "gpt-5", name: "GPT-5", thinkingLevels: ["off", "high"] },
          { provider: "anthropic", id: "claude-4", name: "Claude 4", thinkingLevels: ["off"] },
        ],
        workspaces: [],
        projects: [],
        threads: [],
        settings: {},
      },
      thread: { id: "thread", snapshot: {} },
    },
    store: { configure: mocks.configure },
  });
  await act(async () =>
    root.render(
      createElement(ConfigurationSheet, { configuration: multiConfig, onClose: () => {} }),
    ),
  );
  // Active tab starts on "openai": 2 rail icons + 1 visible model icon = 3.
  expect(document.querySelectorAll("[data-testid='provider-svg']").length).toBe(3);
  expect(document.body.textContent).toContain("GPT-5");
  expect(document.body.textContent).not.toContain("Claude 4");

  await act(async () => labelled("All").click());
  expect(document.querySelectorAll("[data-testid='provider-svg']").length).toBe(4);
  expect(document.body.textContent).toContain("GPT-5");
  expect(document.body.textContent).toContain("Claude 4");

  await act(async () => labelled("anthropic").click());
  expect(document.body.textContent).toContain("Claude 4");
  expect(document.body.textContent).not.toContain("GPT-5");
});
