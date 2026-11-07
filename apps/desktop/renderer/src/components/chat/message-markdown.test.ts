// @vitest-environment jsdom
import { act, createElement } from "react";
import { getSharedHighlighter } from "@pierre/diffs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { i18n } from "@/i18n";
import { MessageMarkdown } from "./message-markdown";

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("renders highlighted code and supports copying and wrapping", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  await getSharedHighlighter({
    themes: ["pierre-light"],
    langs: ["typescript"],
    preferredHighlighter: "shiki-js",
  });
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root?.render(
      createElement(MessageMarkdown, { text: "```typescript\nconst answer = 42;\n```" }),
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(element.querySelector("code span[style]")).not.toBeNull();
  expect(element.textContent).toContain("TypeScript");
  expect(element.querySelector("code")?.textContent).toBe("const answer = 42;");
  const wrap = element.querySelector('button[aria-label="Wrap lines"]') as HTMLButtonElement;
  await act(async () => wrap.click());
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  await act(async () =>
    (element.querySelector('button[aria-label="Copy code"]') as HTMLButtonElement).click(),
  );
  expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  expect(element.querySelector('button[aria-label="Copied"]')).not.toBeNull();
});

test("keeps unknown and unlabelled code readable and inline code inline", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root?.render(
      createElement(MessageMarkdown, {
        text: "`inline`\n\n```\nplain\n```\n\n```not-a-language\nunknown\n```",
      }),
    ),
  );
  expect(element.textContent).toContain("Plain text");
  expect(element.textContent).toContain("not-a-language");
  expect(Array.from(element.querySelectorAll("pre code"), (node) => node.textContent)).toEqual([
    "plain",
    "unknown",
  ]);
  expect(element.querySelector("p code")?.textContent).toBe("inline");
});

test("streamed updates replace previously highlighted and copied content", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  await getSharedHighlighter({
    themes: ["pierre-light"],
    langs: ["typescript"],
    preferredHighlighter: "shiki-js",
  });
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root?.render(
      createElement(MessageMarkdown, {
        text: "```typescript\nconst a = 1;\n```",
      }),
    ),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(element.querySelector("code span[style]")).not.toBeNull();
  await act(async () =>
    (element.querySelector('button[aria-label="Copy code"]') as HTMLButtonElement).click(),
  );
  await act(async () =>
    root?.render(
      createElement(MessageMarkdown, {
        text: "```typescript\nconst a = 12;\n```",
      }),
    ),
  );
  expect(element.querySelector("pre code")?.textContent).toBe("const a = 12;");
  expect(element.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
});
