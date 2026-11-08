// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { appearance } from "@/appearance";
import type { AppearanceSnapshot } from "../../../../src/appearance.ts";
import { CodeBlock } from "./code-block";

const highlighter = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@pierre/diffs", () => ({ getSharedHighlighter: highlighter.get }));
let root: Root | undefined;
let off: (() => void) | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  off?.();
  root = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  highlighter.get.mockReset();
});

function delayedHighlighter(color: string) {
  let resolve!: (value: {
    codeToTokens: () => { tokens: { content: string; color: string }[][] };
  }) => void;
  const promise = new Promise<Parameters<typeof resolve>[0]>((done) => {
    resolve = done;
  });
  return {
    promise,
    finish: () =>
      resolve({ codeToTokens: () => ({ tokens: [[{ content: "const x = 1;", color }]] }) }),
  };
}

test("switching themes keeps code and controls mounted, drops old tokens and rejects late old highlights", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  let emit!: (snapshot: AppearanceSnapshot) => void;
  const initial: AppearanceSnapshot = { preference: "light", resolved: "light", revision: 0 };
  off = appearance.connect({
    initialAppearance: initial,
    appearance: async () => initial,
    subscribeAppearance: (listener) => {
      emit = listener;
      return () => {};
    },
  });
  const old = delayedHighlighter("#111111");
  const dark = delayedHighlighter("#eeeeee");
  const light = delayedHighlighter("#222222");
  highlighter.get
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(dark.promise)
    .mockReturnValueOnce(light.promise);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(createElement(CodeBlock, { code: "const x = 1;", language: "typescript" })),
  );
  const pre = container.querySelector("pre")!;
  const controls = [...container.querySelectorAll("button")];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  await act(async () => emit({ preference: "dark", resolved: "dark", revision: 1 }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
    dark.finish();
  });
  expect(highlighter.get.mock.calls[1]?.[0]).toMatchObject({ themes: ["pierre-dark"] });
  expect(container.querySelector("code span span")?.getAttribute("style")).toContain(
    "rgb(238, 238, 238)",
  );
  await act(async () => old.finish());
  expect(container.querySelector("code span span")?.getAttribute("style")).toContain(
    "rgb(238, 238, 238)",
  );
  await act(async () => emit({ preference: "light", resolved: "light", revision: 2 }));
  expect(container.querySelector("code span[style]")).toBeNull();
  expect(pre.textContent).toBe("const x = 1;");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
    light.finish();
  });
  expect(container.querySelector("pre")).toBe(pre);
  expect([...container.querySelectorAll("button")]).toEqual(controls);
  expect(container.querySelector("code span span")?.getAttribute("style")).toContain(
    "rgb(34, 34, 34)",
  );
});
