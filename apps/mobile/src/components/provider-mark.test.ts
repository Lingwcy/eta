// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

vi.mock("../ui.tsx", () => ({
  colors: { secondary: "#52525b" },
}));
vi.mock("lucide-react-native", () => ({
  Bot: ({ color, size }: { color?: string; size?: number }) =>
    createElement("span", {
      "data-testid": "fallback-bot",
      "data-color": color,
      "data-size": size,
    }),
}));
vi.mock("react-native-svg", () => ({
  SvgXml: ({ xml, width, height }: { xml: string; width?: number; height?: number }) =>
    createElement("span", {
      "data-testid": "provider-svg",
      "data-width": width,
      "data-height": height,
      "data-xml": xml,
    }),
}));
vi.mock("react-native", () => ({
  Image: ({ source, style }: { source: unknown; style?: { width?: number; height?: number } }) =>
    createElement("img", {
      "data-testid": "provider-image",
      src: String(source),
      width: style?.width,
      height: style?.height,
    }),
}));

import { ProviderMark, resolveProviderAsset } from "./provider-mark.tsx";

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

test("resolves desktop provider aliases and raster logos while ignoring prototype keys", () => {
  expect(resolveProviderAsset("openai-codex")).toMatchObject({ kind: "svg", file: "openai.svg" });
  expect(resolveProviderAsset("Qwen-Token-Plan-CN")).toMatchObject({
    kind: "svg",
    file: "qwen-color.svg",
  });
  expect(resolveProviderAsset("xiaomi-token-plan-ams")).toMatchObject({
    kind: "svg",
    file: "xiaomimimo.svg",
  });
  expect(resolveProviderAsset("zai-coding-cn")).toMatchObject({ kind: "svg", file: "zai.svg" });
  expect(resolveProviderAsset("ant-ling")).toMatchObject({ kind: "image", file: "ant-ling.png" });
  expect(resolveProviderAsset("typesafe")).toMatchObject({ kind: "image", file: "typesafe.png" });
  expect(resolveProviderAsset("constructor")).toBeNull();
  expect(resolveProviderAsset("__proto__")).toBeNull();
  expect(resolveProviderAsset("unknown-provider")).toBeNull();
});

test("renders currentColor monochrome SVG, grayscale -color SVG, raster PNG, and Bot fallback", async () => {
  await act(async () =>
    root.render(createElement(ProviderMark, { id: "anthropic", size: 18, color: "#123456" })),
  );
  const mono = document.querySelector("[data-testid='provider-svg']");
  expect(mono?.getAttribute("data-xml")).toContain("#123456");
  expect(mono?.getAttribute("data-xml")).not.toContain("currentColor");
  expect(mono?.getAttribute("data-width")).toBe("18");

  await act(async () => root.render(createElement(ProviderMark, { id: "google", size: 16 })));
  const gray = document.querySelector("[data-testid='provider-svg']");
  const hexes = gray?.getAttribute("data-xml")?.match(/#[0-9a-fA-F]{6}/g) ?? [];
  expect(hexes.length).toBeGreaterThan(0);
  for (const hex of hexes) {
    expect(hex.slice(1, 3)).toBe(hex.slice(3, 5));
    expect(hex.slice(3, 5)).toBe(hex.slice(5, 7));
  }

  await act(async () => root.render(createElement(ProviderMark, { id: "ant-ling", size: 14 })));
  expect(document.querySelector("[data-testid='provider-image']")).not.toBeNull();

  await act(async () =>
    root.render(createElement(ProviderMark, { id: "missing-vendor", size: 14 })),
  );
  expect(document.querySelector("[data-testid='fallback-bot']")).not.toBeNull();
});
