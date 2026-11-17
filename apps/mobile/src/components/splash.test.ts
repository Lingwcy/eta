// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 16, left: 0, right: 0 }),
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children);
  const Text = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", {}, children);
  const Image = ({
    source,
    accessibilityLabel,
  }: {
    source: string | { uri?: string };
    accessibilityLabel?: string;
  }) =>
    React.createElement("img", {
      src: typeof source === "string" ? source : (source?.uri ?? ""),
      alt: accessibilityLabel,
    });
  return {
    View,
    Text,
    Image,
    StyleSheet: {
      create: <T>(styles: T) => styles,
      hairlineWidth: 1,
    },
  };
});

import { BrandSplash } from "./splash.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

test("BrandSplash renders brand lockup, mark, and status label", () => {
  act(() => {
    root.render(createElement(BrandSplash, { label: "Loading connection…" }));
  });
  expect(container.textContent).toContain("eta");
  expect(container.textContent).toContain("CODING AGENT");
  expect(container.textContent).toContain("Loading connection…");
  expect(container.querySelector("img")?.getAttribute("alt")).toBe("Eta logo");
});
