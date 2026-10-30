// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement, Fragment, useLayoutEffect, useState } from "react";
import { getSharedHighlighter } from "@pierre/diffs";
import type { SnapshotTool } from "@eta/core/agent/protocol";
import { FileDiffActions, type FileDiffSelection } from "@/agent/file-diff-actions";
import { ToolItem } from "@/components/task-list/tool-item";
import { createRoot, type Root } from "react-dom/client";
import type { DiffContent, WorkspaceChanges, WorkspaceDiffScope } from "@eta/core/shared/diff";
import { i18n } from "@/i18n";
import { DiffPanel } from "./diff-panel";
import { DiffPreview } from "./diff-preview";

let root: Root | undefined;
const observed = new Set<Element>();

// jsdom lacks native observers and adopted stylesheet parsing; the package itself is not mocked.
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [{ target, isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(CSSStyleSheet.prototype, "replaceSync", { configurable: true, value() {} });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  observed.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function patch(name = "example.ts", before = "const value = 1;", after = "const value = 2;") {
  return `diff --git a/${name} b/${name}\nindex 1111111..2222222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

function ready(name = "example.ts", before?: string, after?: string): DiffContent {
  return { status: "ready", path: name, patch: patch(name, before, after) };
}

function listing(
  scope: WorkspaceDiffScope = "all",
  names = ["example.ts", "second.ts"],
): WorkspaceChanges {
  return {
    status: "ready",
    workspaceId: "workspace",
    scope,
    revision: `revision-${scope}`,
    files: names.map((path) => ({
      id: `${scope}:${path}`,
      path,
      kind: "modified",
      staged: true,
      unstaged: true,
    })),
  };
}

function bridge() {
  const api = {
    workspaceChanges: vi.fn(async (input: { scope: WorkspaceDiffScope }) => listing(input.scope)),
    workspaceFileDiff: vi.fn(async () => ready()),
    fileChangeDiff: vi.fn(async () =>
      ready("historical.ts", "before historical", "after historical"),
    ),
  };
  Object.defineProperty(window, "eta", { configurable: true, value: api });
  return api;
}

async function render(element: React.ReactNode) {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(element));
}

function button(text: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === text || node.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

async function expectCode(text: string) {
  await vi.waitFor(
    async () => {
      await act(async () => {
        expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).toContain(text);
      });
    },
    { timeout: 5000 },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("real published Pierre renderer shows both sides, changes layout and releases observers", async () => {
  const positions = new Map<string, number>();
  await render(
    createElement(DiffPreview, { patch: patch(), layout: "unified", location: "one", positions }),
  );
  await expectCode("const value = 1;");
  await expectCode("const value = 2;");
  expect(
    document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector("input, textarea, [contenteditable=true]"),
  ).toBeNull();
  await render(
    createElement(DiffPreview, { patch: patch(), layout: "split", location: "one", positions }),
  );
  await expectCode("const value = 2;");
  expect(
    document.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("code").length,
  ).toBe(2);
  await act(async () => root?.unmount());
  root = undefined;
  expect(observed.size).toBe(0);
});

test("hidden panels do not load; selecting files and scopes only loads the selected content", async () => {
  const api = bridge();
  await render(createElement(DiffPanel, { workspaceId: "workspace", active: false }));
  expect(api.workspaceChanges).not.toHaveBeenCalled();
  expect(api.workspaceFileDiff).not.toHaveBeenCalled();
  await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(1);
  expect(api.workspaceFileDiff).toHaveBeenCalledTimes(1);
  await expectCode("const value = 2;");
  await act(async () => document.querySelector<HTMLButtonElement>('[title="second.ts"]')!.click());
  expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "all",
    entryId: "all:second.ts",
    expectedRevision: "revision-all",
  });
  await click("Staged");
  expect(api.workspaceChanges).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "staged",
  });
  expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "staged",
    entryId: "staged:example.ts",
    expectedRevision: "revision-staged",
  });
  await click("All");
  expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "all",
    entryId: "all:second.ts",
    expectedRevision: "revision-all",
  });
});

test("historical and current data remain separate when switching sources", async () => {
  const api = bridge();
  const props = {
    workspaceId: "workspace",
    active: true,
    history: { threadId: "thread", changeId: "change", path: "historical.ts" },
  };
  await render(createElement(DiffPanel, props));
  expect(api.workspaceChanges).not.toHaveBeenCalled();
  expect(api.fileChangeDiff).toHaveBeenCalledWith({ threadId: "thread", changeId: "change" });
  await expectCode("after historical");
  await click("Workspace changes");
  await expectCode("const value = 2;");
  await click("This modification");
  await expectCode("after historical");
  expect(api.fileChangeDiff).toHaveBeenCalledTimes(2);
  const calls = api.workspaceChanges.mock.calls.length;
  await render(createElement(DiffPanel, { ...props, revision: 4 }));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(calls);
});

test("late file replies and errors cannot replace the current file or connection", async () => {
  const api = bridge();
  const first = deferred<DiffContent>();
  api.workspaceFileDiff
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(async () => ready("second.ts", "old second", "new second"));
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      connectionKey: "connection-one",
    }),
  );
  await act(async () => document.querySelector<HTMLButtonElement>('[title="second.ts"]')!.click());
  await expectCode("new second");
  await act(async () => first.resolve(ready("example.ts", "stale old", "stale new")));
  await expectCode("new second");
  expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).not.toContain(
    "stale new",
  );
  const pending = deferred<WorkspaceChanges>();
  api.workspaceChanges.mockImplementationOnce(() => pending.promise);
  await click("Refresh changes");
  api.workspaceChanges.mockResolvedValue(listing("all", ["replacement.ts"]));
  api.workspaceFileDiff.mockResolvedValue(
    ready("replacement.ts", "replacement old", "replacement new"),
  );
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      connectionKey: "connection-two",
    }),
  );
  await expectCode("replacement new");
  await act(async () => pending.reject(new Error("old connection failed")));
  await expectCode("replacement new");
  expect(document.body.textContent).not.toContain("Could not load changes");
});

test("unavailable content, empty repositories and failures remain distinct and retryable", async () => {
  const api = bridge();
  api.workspaceFileDiff.mockResolvedValue({ status: "unavailable", reason: "binary" });
  await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
  expect(document.body.textContent).toContain("Binary files cannot be previewed as text");
  api.workspaceChanges.mockRejectedValueOnce(new Error("git failed"));
  await click("Refresh changes");
  expect(document.body.textContent).toContain("Could not load changes");
  expect(document.body.textContent).not.toContain("No changes in this comparison");
  api.workspaceChanges.mockResolvedValue(listing("all", []));
  await click("Retry");
  expect(document.body.textContent).toContain("No changes in this comparison");
  api.workspaceChanges.mockResolvedValue({ status: "not-repository", workspaceId: "workspace" });
  await click("Refresh changes");
  expect(document.body.textContent).toContain("not a Git repository");
});

test("selected patch limits are enforced before mounting the third-party renderer", async () => {
  await render(
    createElement(DiffPreview, {
      patch: "x".repeat(1024 * 1024 + 1),
      layout: "unified",
      location: "large",
      positions: new Map(),
    }),
  );
  expect(document.body.textContent).toContain("too large");
  expect(document.querySelector("diffs-container")).toBeNull();
});

test("published JavaScript highlighter resolves packaged languages and both palettes", async () => {
  const highlighter = await getSharedHighlighter({
    themes: ["pierre-light", "pierre-dark"],
    langs: ["typescript"],
    preferredHighlighter: "shiki-js",
  });
  expect(highlighter.name).toBe("shiki-js");
  const light = highlighter.codeToTokens("const answer = 42;", {
    lang: "typescript",
    theme: "pierre-light",
  });
  const dark = highlighter.codeToTokens("const answer = 42;", {
    lang: "typescript",
    theme: "pierre-dark",
  });
  expect(light.tokens.flat().some((token) => token.color)).toBe(true);
  expect(dark.tokens).not.toEqual(light.tokens);
  await render(
    createElement(DiffPreview, {
      patch: patch(),
      layout: "unified",
      location: "highlighted",
      positions: new Map(),
    }),
  );
  await expectCode("const value = 2;");
  await vi.waitFor(() => {
    const shadow = document.querySelector("diffs-container")?.shadowRoot;
    expect(shadow?.querySelectorAll('span[style*="--diffs-token-light"]').length).toBeGreaterThan(
      0,
    );
    expect(shadow?.querySelector("[data-theme-css]")?.textContent).toContain(
      "prefers-color-scheme: dark",
    );
  });
});

test("chat modification action opens saved history while the workspace source reads current content", async () => {
  const api = bridge();
  const tool: SnapshotTool = {
    toolCallId: "call",
    taskId: "task",
    toolName: "edit",
    status: "settled",
    args: { path: "historical.ts" },
    result: {
      content: [{ type: "text", text: "Replaced one block" }],
      details: { fileChange: { id: "change", path: "historical.ts", status: "recorded" } },
    },
  };
  function ChatAndInspector() {
    const [history, setHistory] = useState<FileDiffSelection & { requestId: string }>();
    return createElement(
      Fragment,
      null,
      createElement(FileDiffActions, {
        threadId: "thread",
        workspaceId: "workspace",
        onOpen: (selected) => setHistory({ ...selected, requestId: crypto.randomUUID() }),
        children: createElement(ToolItem, { tool }),
      }),
      createElement(DiffPanel, { workspaceId: "workspace", active: Boolean(history), history }),
    );
  }
  await render(createElement(ChatAndInspector));
  expect(api.fileChangeDiff).not.toHaveBeenCalled();
  await click("View modification");
  await expectCode("after historical");
  expect(api.fileChangeDiff).toHaveBeenCalledWith({ threadId: "thread", changeId: "change" });
  api.workspaceFileDiff.mockResolvedValue(
    ready("historical.ts", "after historical", "newer workspace value"),
  );
  await click("Workspace changes");
  await expectCode("newer workspace value");
  await click("This modification");
  await expectCode("after historical");
  expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).not.toContain(
    "newer workspace value",
  );
  await click("Workspace changes");
  await expectCode("newer workspace value");
  await click("View modification");
  await expectCode("after historical");
  expect(button("This modification").getAttribute("aria-pressed")).toBe("true");
});

test("a many-thousand-line patch does not mount its complete line DOM", async () => {
  const count = 4000;
  const large =
    "diff --git a/large.txt b/large.txt\n--- a/large.txt\n+++ b/large.txt\n@@ -1," +
    count +
    " +1," +
    count +
    " @@\n" +
    Array.from({ length: count }, (_, index) => "-before " + index + "\n").join("") +
    Array.from({ length: count }, (_, index) => "+after " + index + "\n").join("");
  await render(
    createElement(DiffPreview, {
      patch: large,
      layout: "unified",
      location: "large",
      positions: new Map(),
    }),
  );
  await expectCode("before 0");
  const rows = document
    .querySelector("diffs-container")
    ?.shadowRoot?.querySelectorAll("[data-line]");
  expect(rows!.length).toBeGreaterThan(0);
  expect(rows!.length).toBeLessThan(300);
});

test("same-workspace reopen renders loading rather than the previous patch", async () => {
  const api = bridge();
  const props = { workspaceId: "workspace", active: true };
  const painted: boolean[] = [];
  function PaintProbe({ active }: { active: boolean }) {
    useLayoutEffect(() => {
      painted.push(Boolean(document.querySelector("diffs-container")));
    });
    return createElement(DiffPanel, { ...props, active });
  }
  await render(createElement(PaintProbe, props));
  await expectCode("const value = 2;");
  await render(createElement(PaintProbe, { active: false }));
  const pending = deferred<WorkspaceChanges>();
  api.workspaceChanges.mockImplementationOnce(() => pending.promise);
  painted.length = 0;
  await render(createElement(PaintProbe, props));
  expect(painted.length).toBeGreaterThan(0);
  expect(painted).not.toContain(true);
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(document.body.textContent).toContain("Loading changes");
  api.workspaceFileDiff.mockResolvedValue(
    ready("example.ts", "new baseline", "changed while closed"),
  );
  await act(async () => pending.resolve(listing()));
  await expectCode("changed while closed");
});

test("same-workspace thread views with revision zero have independent list admissions", async () => {
  const api = bridge();
  const previous = deferred<WorkspaceChanges>();
  api.workspaceChanges.mockImplementationOnce(() => previous.promise);
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      revision: 0,
      connectionKey: "view-A",
    }),
  );
  api.workspaceChanges.mockResolvedValue(listing("all", ["view-b.ts"]));
  api.workspaceFileDiff.mockResolvedValue(ready("view-b.ts", "before view B", "after view B"));
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      revision: 0,
      connectionKey: "view-B",
    }),
  );
  await expectCode("after view B");
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  await act(async () => previous.resolve(listing("all", ["old-view-a.ts"])));
  expect(document.querySelector('[title="old-view-a.ts"]')).toBeNull();
  await expectCode("after view B");
});

test("completed tool bursts coalesce and hidden revision changes do not run Git", async () => {
  const api = bridge();
  api.workspaceChanges.mockResolvedValue(listing("all", []));
  const props = { workspaceId: "workspace", active: true, revision: 0 };
  await render(createElement(DiffPanel, props));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(1);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await render(createElement(DiffPanel, { ...props, revision: 1 }));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  await render(createElement(DiffPanel, { ...props, revision: 2 }));
  await act(async () => vi.advanceTimersByTimeAsync(99));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  await render(createElement(DiffPanel, { ...props, active: false, revision: 3 }));
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  await render(createElement(DiffPanel, { ...props, revision: 3 }));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(3);
});

test("pure rename metadata renders an explicit no-content-difference state", async () => {
  const rename =
    "diff --git a/before.ts b/after.ts\nsimilarity index 100%\nrename from before.ts\nrename to after.ts\n";
  await render(
    createElement(DiffPreview, {
      patch: rename,
      layout: "unified",
      location: "rename",
      positions: new Map(),
    }),
  );
  expect(document.body.textContent).toContain("No content difference");
  expect(document.querySelector("diffs-container")).toBeNull();
});

test("Unicode content and missing final newlines are previewed without reading a current file", async () => {
  const unicode =
    "diff --git a/unicode.txt b/unicode.txt\n--- a/unicode.txt\n+++ b/unicode.txt\n@@ -1 +1 @@\n-旧内容\n\\ No newline at end of file\n+新的内容 🚀\n\\ No newline at end of file\n";
  await render(
    createElement(DiffPreview, {
      patch: unicode,
      layout: "unified",
      location: "unicode",
      positions: new Map(),
    }),
  );
  await expectCode("旧内容");
  await expectCode("新的内容 🚀");
});

test("an unrecorded legacy write opens an explicit history gap without reading today's workspace", async () => {
  const api = bridge();
  api.fileChangeDiff.mockResolvedValue({ status: "unavailable", reason: "not-recorded" });
  const tool: SnapshotTool = {
    toolCallId: "legacy-write",
    toolName: "write",
    status: "settled",
    args: { path: "old.ts" },
    result: { content: [{ type: "text", text: "Written" }] },
  };
  function Chat() {
    const [history, setHistory] = useState<FileDiffSelection>();
    return createElement(
      Fragment,
      null,
      createElement(FileDiffActions, {
        threadId: "thread",
        workspaceId: "workspace",
        onOpen: setHistory,
        children: createElement(ToolItem, { tool }),
      }),
      createElement(DiffPanel, { workspaceId: "workspace", active: Boolean(history), history }),
    );
  }
  await render(createElement(Chat));
  await click("View modification");
  expect(api.fileChangeDiff).toHaveBeenCalledWith({ threadId: "thread", changeId: "not-recorded" });
  expect(document.body.textContent).toContain(i18n.t("diff:reason.not-recorded"));
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(api.workspaceChanges).not.toHaveBeenCalled();
  expect(api.workspaceFileDiff).not.toHaveBeenCalled();
});
