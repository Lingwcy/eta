// @vitest-environment jsdom
import { act, createElement } from "react";
import { getSharedHighlighter } from "@pierre/diffs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { i18n } from "@/i18n";
import { MarkdownActionsProvider, type MarkdownActions } from "@/agent/markdown-actions";
import { MessageMarkdown } from "./message-markdown";

let root: Root | undefined;
const animations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (animations) Object.defineProperty(HTMLElement.prototype, "getAnimations", animations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

function stubMenuEnvironment() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
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
}

async function openContextMenu(target: Element) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 }));
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 80, clientY: 80 }),
    );
  });
}

async function clickMenuItem(label: string) {
  const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(
    (menu) => !menu.hasAttribute("data-closed") && !menu.hasAttribute("data-ending-style"),
  );
  const scope = menus.at(-1) ?? document;
  const item = [...scope.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!item) throw new Error("Missing menu item: " + label);
  await act(async () => {
    item.click();
  });
}

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

test("renders file:// links and inline workspace paths as interactive file chips with context actions", async () => {
  stubMenuEnvironment();
  await i18n.changeLanguage("en");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  const actions: MarkdownActions = {
    workspaceId: "ws-1",
    cloud: false,
    editors: [
      { id: "vscode", name: "Visual Studio Code" },
      { id: "cursor", name: "Cursor" },
    ],
    openFile: vi.fn(),
    openFileExternal: vi.fn().mockResolvedValue(undefined),
    openWebInBrowser: vi.fn(),
    openWebExternal: vi.fn().mockResolvedValue(undefined),
    openGitHubPanel: vi.fn(),
  };

  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root?.render(
      createElement(
        MarkdownActionsProvider,
        { value: actions },
        createElement(MessageMarkdown, {
          text: "See [`eta-welcome-logo.tsx`](file:///repo/eta-welcome-logo.tsx#L12) and `apps/desktop/src/main.ts:42` and `feat/desktop-chat-welcome`.",
        }),
      ),
    ),
  );

  const fileChips = [
    ...element.querySelectorAll<HTMLButtonElement>('button[data-markdown-block="file"]'),
  ];
  expect(fileChips).toHaveLength(2);
  expect(fileChips[0]!.querySelector("span")?.textContent).toBe("eta-welcome-logo.tsx");
  expect(fileChips[1]!.querySelector("span")?.textContent).toBe("main.ts:42");
  expect(element.querySelector("p > code")?.textContent).toBe("feat/desktop-chat-welcome");

  await act(async () => fileChips[1]!.click());
  expect(actions.openFile).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    path: "apps/desktop/src/main.ts",
    line: 42,
    endLine: undefined,
    column: undefined,
  });

  await openContextMenu(fileChips[0]!);
  await clickMenuItem("Open in Visual Studio Code");
  expect(actions.openFileExternal).toHaveBeenCalledWith({
    path: "/repo/eta-welcome-logo.tsx",
    line: 12,
    column: undefined,
    mode: { kind: "editor", editorId: "vscode" },
  });

  await openContextMenu(fileChips[1]!);
  await clickMenuItem("Copy path");
  expect(writeText).toHaveBeenCalledWith("apps/desktop/src/main.ts:42");
});

test("renders GitHub PR chips and web links opening in built-in browser with context menu actions", async () => {
  stubMenuEnvironment();
  await i18n.changeLanguage("en");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

  const actions: MarkdownActions = {
    workspaceId: "ws-1",
    cloud: false,
    editors: [],
    openFile: vi.fn(),
    openFileExternal: vi.fn().mockResolvedValue(undefined),
    openWebInBrowser: vi.fn(),
    openWebExternal: vi.fn().mockResolvedValue(undefined),
    openGitHubPanel: vi.fn(),
  };

  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root?.render(
      createElement(
        MarkdownActionsProvider,
        { value: actions },
        createElement(MessageMarkdown, {
          text: "PR: https://github.com/Lingwcy/eta/pull/648 and docs [Vite+](https://viteplus.dev/guide/).",
        }),
      ),
    ),
  );

  const prChip = element.querySelector<HTMLAnchorElement>('a[data-markdown-block="github-pr"]')!;
  const webLink = element.querySelector<HTMLAnchorElement>('a[data-markdown-block="web"]')!;
  expect(prChip.textContent).toBe("eta#648");
  expect(webLink.textContent).toBe("Vite+");

  await act(async () => {
    prChip.click();
    webLink.click();
  });
  expect(actions.openWebInBrowser).toHaveBeenNthCalledWith(
    1,
    "https://github.com/Lingwcy/eta/pull/648",
  );
  expect(actions.openWebInBrowser).toHaveBeenNthCalledWith(2, "https://viteplus.dev/guide/");

  await openContextMenu(prChip);
  await clickMenuItem("View in GitHub panel");
  expect(actions.openGitHubPanel).toHaveBeenCalledOnce();

  await openContextMenu(webLink);
  await clickMenuItem("Open in external browser");
  expect(actions.openWebExternal).toHaveBeenCalledWith("https://viteplus.dev/guide/");
});

test("preview mode renders non-interactive spans without context menu triggers or nested buttons", async () => {
  stubMenuEnvironment();
  await i18n.changeLanguage("en");
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  await act(async () =>
    root?.render(
      createElement(MessageMarkdown, {
        preview: true,
        text: "See `apps/desktop/src/main.ts` and https://github.com/Lingwcy/eta/pull/648",
      }),
    ),
  );

  expect(element.querySelector("button")).toBeNull();
  expect(element.querySelector("a")).toBeNull();
  expect(element.querySelector('span[data-markdown-block="file"] > span')?.textContent).toBe(
    "main.ts",
  );
  expect(element.querySelector('span[data-markdown-block="github-pr"]')?.textContent).toBe(
    "eta#648",
  );
});
