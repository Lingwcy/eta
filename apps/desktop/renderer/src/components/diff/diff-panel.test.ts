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
  revision = `revision-${scope}`,
): WorkspaceChanges {
  return {
    status: "ready",
    workspaceId: "workspace",
    scope,
    revision,
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
    workspaceFileDiff: vi.fn(async (_input: { entryId: string }) => ready()),
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

async function focusWorkspace() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}

async function selectFile(path: string) {
  const file = [...document.querySelectorAll<HTMLButtonElement>("nav button")].find(
    (node) => node.title === path,
  );
  if (!file) throw new Error("Missing file: " + path);
  await act(async () => file.click());
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

test("hidden panels do not load; file selection and focus refresh retain the all-changes comparison", async () => {
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
  await focusWorkspace();
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  expect(api.workspaceChanges).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "all",
  });
  expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "all",
    entryId: "all:second.ts",
    expectedRevision: "revision-all",
  });
});

test.each(["focus", "completion"] as const)(
  "%s refresh keeps the tree and preview mounted until the replacement patch is ready",
  async (trigger) => {
    const api = bridge();
    const props = { workspaceId: "workspace", active: true };
    await render(createElement(DiffPanel, props));
    await expectCode("const value = 2;");
    const preview = document.querySelector("diffs-container")!;
    const region = document.querySelector('[role="region"]')!;
    const scroller = region.firstElementChild!;
    const nav = document.querySelector("nav")!;
    const selected = nav.querySelector('[aria-pressed="true"]');
    await act(async () => {
      scroller.scrollTop = 400;
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
      nav.scrollTop = 120;
    });
    const nextList = deferred<WorkspaceChanges>();
    const nextPatch = deferred<DiffContent>();
    api.workspaceChanges.mockImplementationOnce(() => nextList.promise);
    api.workspaceFileDiff.mockImplementationOnce(() => nextPatch.promise);
    if (trigger === "focus") await focusWorkspace();
    else {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await render(createElement(DiffPanel, { ...props, revision: 1 }));
      await act(async () => vi.advanceTimersByTimeAsync(100));
      vi.useRealTimers();
    }
    expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
    expect(document.querySelector("diffs-container")).toBe(preview);
    expect(nav.querySelector('[aria-pressed="true"]')).toBe(selected);
    expect(api.workspaceFileDiff).toHaveBeenCalledTimes(1);
    await act(async () => nextList.resolve(listing("all", undefined, "new-revision")));
    expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
      workspaceId: "workspace",
      scope: "all",
      entryId: "all:example.ts",
      expectedRevision: "new-revision",
    });
    expect(api.workspaceFileDiff).toHaveBeenCalledTimes(2);
    expect(document.querySelector("diffs-container")).toBe(preview);
    expect(nav.querySelector('[aria-pressed="true"]')).toBe(selected);
    expect(document.body.textContent).not.toContain("Loading changes");
    // Continue reading while the patch is pending; completion must not restore an earlier offset.
    await act(async () => {
      scroller.scrollTop = 800;
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    await act(async () => nextPatch.resolve(ready("example.ts", undefined, "updated value")));
    await expectCode("updated value");
    expect(document.querySelector("diffs-container")).toBe(preview);
    expect(region.firstElementChild).toBe(scroller);
    expect(scroller.scrollTop).toBe(800);
    expect(nav.scrollTop).toBe(120);
  },
);

test.each(["resolve", "reject"] as const)(
  "a late same-file refresh %s cannot overwrite the newest patch",
  async (settlement) => {
    const api = bridge();
    await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
    await expectCode("const value = 2;");
    const older = deferred<DiffContent>();
    api.workspaceFileDiff.mockImplementationOnce(() => older.promise);
    await focusWorkspace();
    const newer = deferred<DiffContent>();
    api.workspaceFileDiff.mockImplementationOnce(() => newer.promise);
    await focusWorkspace();
    await act(async () => newer.resolve(ready("example.ts", undefined, "newest refresh")));
    await expectCode("newest refresh");
    const preview = document.querySelector("diffs-container");
    await act(async () => {
      if (settlement === "resolve") older.resolve(ready("example.ts", undefined, "obsolete patch"));
      else older.reject(new Error("obsolete failure"));
    });
    expect(document.querySelector("diffs-container")).toBe(preview);
    await expectCode("newest refresh");
    expect(document.body.textContent).not.toContain("Could not load changes");
  },
);

test("a failed patch refresh leaves an actionable error and retry replaces the old patch", async () => {
  const api = bridge();
  await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
  await expectCode("const value = 2;");
  const pending = deferred<DiffContent>();
  api.workspaceFileDiff.mockImplementationOnce(() => pending.promise);
  await focusWorkspace();
  await act(async () => pending.reject(new Error("current failure")));
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(document.body.textContent).toContain("Could not load changes");
  api.workspaceFileDiff.mockResolvedValue(ready("example.ts", undefined, "recovered patch"));
  await click("Retry");
  await expectCode("recovered patch");
});

test("a file switch during refresh clears the old preview and rejects its late replacement", async () => {
  const api = bridge();
  await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
  await expectCode("const value = 2;");
  const oldRefresh = deferred<DiffContent>();
  api.workspaceFileDiff.mockImplementationOnce(() => oldRefresh.promise);
  await focusWorkspace();
  const selectedFile = deferred<DiffContent>();
  api.workspaceFileDiff.mockImplementationOnce(() => selectedFile.promise);
  await selectFile("second.ts");
  expect(document.querySelector("diffs-container")).toBeNull();
  expect(document.body.textContent).toContain("Loading changes");
  await act(async () => oldRefresh.resolve(ready("example.ts", undefined, "obsolete refresh")));
  expect(document.querySelector("diffs-container")).toBeNull();
  await act(async () => selectedFile.resolve(ready("second.ts", undefined, "selected content")));
  await expectCode("selected content");
});

test("history stays frozen while the live tree refreshes; file selection returns to current content", async () => {
  const api = bridge();
  const props = {
    workspaceId: "workspace",
    active: true,
    history: { threadId: "thread", changeId: "change", path: "historical.ts", requestId: "first" },
  };
  await render(createElement(DiffPanel, props));
  expect(api.workspaceChanges).toHaveBeenCalledWith({ workspaceId: "workspace", scope: "all" });
  expect(api.workspaceFileDiff).not.toHaveBeenCalled();
  expect(api.fileChangeDiff).toHaveBeenCalledWith({ threadId: "thread", changeId: "change" });
  await expectCode("after historical");
  await selectFile("example.ts");
  await expectCode("const value = 2;");
  await render(
    createElement(DiffPanel, { ...props, history: { ...props.history, requestId: "second" } }),
  );
  await expectCode("after historical");
  expect(api.fileChangeDiff).toHaveBeenCalledTimes(2);
  await focusWorkspace();
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  expect(api.fileChangeDiff).toHaveBeenCalledTimes(2);
  expect(api.workspaceFileDiff).toHaveBeenCalledTimes(1);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await render(
    createElement(DiffPanel, {
      ...props,
      revision: 4,
      history: { ...props.history, requestId: "second" },
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(3);
  await expectCode("after historical");
  expect(api.fileChangeDiff).toHaveBeenCalledTimes(2);
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
  await focusWorkspace();
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
  await focusWorkspace();
  expect(document.body.textContent).toContain("Could not load changes");
  expect(document.body.textContent).not.toContain("No changes in this comparison");
  api.workspaceChanges.mockResolvedValue(listing("all", []));
  await click("Retry");
  expect(document.body.textContent).toContain("No changes in this comparison");
  api.workspaceChanges.mockResolvedValue({ status: "not-repository", workspaceId: "workspace" });
  await focusWorkspace();
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
  await selectFile("example.ts");
  await expectCode("newer workspace value");
  await click("View modification");
  await expectCode("after historical");
  expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).not.toContain(
    "newer workspace value",
  );
  await selectFile("example.ts");
  await expectCode("newer workspace value");
  await click("View modification");
  await expectCode("after historical");
  expect(document.querySelector('nav button[aria-pressed="true"]')).toBeNull();
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

test("an unrecorded legacy write shows a history gap, not the current file content", async () => {
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
  expect(api.workspaceChanges).toHaveBeenCalledWith({ workspaceId: "workspace", scope: "all" });
  expect(api.workspaceFileDiff).not.toHaveBeenCalled();
});

test.each([
  ["en", ["Workspace changes", "All", "Staged", "Unstaged", "Unified", "Split"]],
  ["zh-CN", ["工作区变更", "全部", "已暂存", "未暂存", "单栏", "双栏"]],
] as const)(
  "%s file browser has no source, scope or layout toolbar while keeping file navigation",
  async (locale, labels) => {
    const api = bridge();
    await i18n.changeLanguage(locale);
    await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
    await expectCode("const value = 2;");
    for (const label of labels) expect(document.body.textContent).not.toContain(label);
    expect(api.workspaceChanges).toHaveBeenCalledWith({ workspaceId: "workspace", scope: "all" });
    const files = document.querySelector("nav");
    expect(files?.querySelectorAll("button")).toHaveLength(2);
    expect(document.querySelectorAll("section > div button").length).toBe(
      files?.querySelectorAll("button").length,
    );
    await act(async () => files!.querySelector<HTMLButtonElement>('[title="second.ts"]')!.click());
    expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
      workspaceId: "workspace",
      scope: "all",
      entryId: "all:second.ts",
      expectedRevision: "revision-all",
    });
  },
);

test("directory collapse survives parent toggles and focus refresh; duplicate basenames select their own content", async () => {
  const api = bridge();
  api.workspaceChanges.mockResolvedValue(
    listing("all", [
      "src/components/a.tsx",
      "src/components/z.tsx",
      "src/utils/a.tsx",
      "README.md",
    ]),
  );
  api.workspaceFileDiff.mockImplementation(async ({ entryId }) => {
    const path = entryId.slice(4);
    return ready(path, "before " + path, "after " + path);
  });
  await render(createElement(DiffPanel, { workspaceId: "workspace", active: true }));
  await expectCode("after src/components/a.tsx");
  await click("src/components");
  expect(document.querySelector('nav button[title="src/components/a.tsx"]')).toBeNull();
  await click("src");
  await click("src");
  expect(document.querySelector('nav button[title="src/components/a.tsx"]')).toBeNull();
  await focusWorkspace();
  expect(document.querySelector('nav button[title="src/components/a.tsx"]')).toBeNull();
  await act(async () =>
    button("src/components").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    ),
  );
  expect(document.querySelector('nav button[title="src/components/a.tsx"]')).not.toBeNull();
  await selectFile("src/utils/a.tsx");
  await expectCode("after src/utils/a.tsx");
  expect(api.workspaceFileDiff).toHaveBeenLastCalledWith({
    workspaceId: "workspace",
    scope: "all",
    entryId: "all:src/utils/a.tsx",
    expectedRevision: "revision-all",
  });
});

test("history and live-tree failures retry independently without substituting current content", async () => {
  const api = bridge();
  api.workspaceChanges.mockRejectedValueOnce(new Error("workspace gone"));
  api.fileChangeDiff.mockRejectedValueOnce(new Error("history read failed"));
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      history: { threadId: "thread", changeId: "change", path: "historical.ts" },
    }),
  );
  await click("Retry");
  await expectCode("after historical");
  expect(api.fileChangeDiff).toHaveBeenCalledTimes(2);
  expect(api.workspaceChanges).toHaveBeenCalledTimes(1);
  expect(api.workspaceFileDiff).not.toHaveBeenCalled();
  await click("Retry");
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  expect(api.fileChangeDiff).toHaveBeenCalledTimes(2);
  await expectCode("after historical");
  await selectFile("second.ts");
  await expectCode("const value = 2;");
});

test("a missing Git workspace does not block or replace recorded history", async () => {
  const api = bridge();
  api.workspaceChanges.mockResolvedValue({ status: "not-repository", workspaceId: "workspace" });
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      history: { threadId: "thread", changeId: "change", path: "historical.ts" },
    }),
  );
  await expectCode("after historical");
  expect(api.workspaceFileDiff).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("This modification");
  expect(document.body.textContent).toContain("not a Git repository");
});

test("a historical reply arriving after file-tree selection cannot replace the current diff", async () => {
  const api = bridge();
  const historical = deferred<DiffContent>();
  api.fileChangeDiff.mockImplementationOnce(() => historical.promise);
  await render(
    createElement(DiffPanel, {
      workspaceId: "workspace",
      active: true,
      history: { threadId: "thread", changeId: "change", path: "historical.ts" },
    }),
  );
  await selectFile("second.ts");
  await expectCode("const value = 2;");
  await act(async () => historical.resolve(ready("historical.ts", "old history", "late history")));
  await expectCode("const value = 2;");
  expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).not.toContain(
    "late history",
  );
});
