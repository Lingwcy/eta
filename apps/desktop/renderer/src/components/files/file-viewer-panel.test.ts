// @vitest-environment jsdom
import { act, createElement } from "react";
import { getSharedHighlighter } from "@pierre/diffs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { i18n } from "@/i18n";
import { ToastProvider } from "@/components/ui/toast";
import { InspectorTabs } from "@/components/inspector/inspector-tabs";
import { useFileViewer } from "@/agent/use-file-viewer";
import type { WorkspaceFilePreviewResult } from "../../../../src/shared/workspace-files.ts";
import { FileViewerPanel } from "./file-viewer-panel";

let root: Root | undefined;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("FileViewerPanel highlights target lines, renders breadcrumbs, keeps content mounted on refresh, and jumps to diff", async () => {
  await getSharedHighlighter({
    themes: ["pierre-light"],
    langs: ["typescript"],
    preferredHighlighter: "shiki-js",
  });

  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;

  const firstRead = Promise.withResolvers<WorkspaceFilePreviewResult>();
  const refreshRead = Promise.withResolvers<WorkspaceFilePreviewResult>();
  const readWorkspaceFile = vi
    .fn()
    .mockReturnValueOnce(firstRead.promise)
    .mockReturnValueOnce(refreshRead.promise);
  const openFileTarget = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("eta", { readWorkspaceFile, openFileTarget });

  const onOpenDiff = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  function Harness() {
    const viewer = useFileViewer({
      workspaceId: "ws-1",
      connectionKey: "local:tab1",
      onOpen: () => {},
    });
    return createElement(
      ToastProvider,
      null,
      createElement(
        "button",
        {
          type: "button",
          "data-open": "main",
          onClick: () => viewer.open({ path: "src/main.ts", line: 2, endLine: 3 }),
        },
        "Open",
      ),
      viewer.active &&
        createElement(InspectorTabs, {
          value: "files",
          onChange: () => {},
          files: createElement(FileViewerPanel, {
            tabs: viewer.tabs,
            active: viewer.active,
            refreshRevision: viewer.refreshRevision,
            onSelect: viewer.select,
            onClose: viewer.close,
            onRefresh: viewer.refresh,
            changedPaths: new Set(["src/main.ts"]),
            onOpenDiff,
            editors: [{ id: "vscode", name: "Visual Studio Code" }],
            cloud: false,
          }),
        }),
    );
  }

  await act(async () => root!.render(createElement(Harness)));
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-open="main"]')?.click();
  });

  expect(container.querySelector("output")?.textContent).toBe("Loading file…");

  await act(async () => {
    firstRead.resolve({
      status: "ready",
      absolutePath: "/repo/src/main.ts",
      displayPath: "src/main.ts",
      rootName: "eta",
      name: "main.ts",
      language: "typescript",
      content: "const a = 1;\nconst b = 2;\nconst c = 3;",
      truncated: false,
      totalLines: 3,
      size: 38,
    });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(container.querySelector('nav[aria-label="File path"]')?.textContent).toContain("eta");
  expect(container.querySelector('[aria-current="page"] > span')?.textContent).toBe("main.ts");
  expect(
    [...container.querySelectorAll('[data-highlighted-line="true"]')].map((el) =>
      el.getAttribute("data-line"),
    ),
  ).toEqual(["2", "3"]);
  expect(scrollIntoView).toHaveBeenCalled();

  const viewDiffButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="View diff"]',
  )!;
  await act(async () => viewDiffButton.click());
  expect(onOpenDiff).toHaveBeenCalledWith("src/main.ts");

  const vscodeButton = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Open in Visual Studio Code"]',
  )!;
  await act(async () => vscodeButton.click());
  expect(openFileTarget).toHaveBeenCalledWith({
    workspaceId: "ws-1",
    path: "src/main.ts",
    line: 2,
    mode: { kind: "editor", editorId: "vscode" },
  });

  // Refresh keeps the mounted lines visible while the updated read is pending.
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="Refresh file"]')?.click();
  });
  expect(container.querySelectorAll("[data-line]").length).toBe(3);

  await act(async () => {
    refreshRead.resolve({
      status: "ready",
      absolutePath: "/repo/src/main.ts",
      displayPath: "src/main.ts",
      rootName: "eta",
      name: "main.ts",
      language: "typescript",
      content: "const a = 10;",
      truncated: false,
      totalLines: 1,
      size: 13,
    });
  });
  expect(container.querySelector('[data-line="1"]')?.textContent).toContain("const a = 10;");
});

test("FileViewerPanel ignores stale reads across tab switches and renders unavailable reasons cleanly", async () => {
  const slowA = Promise.withResolvers<WorkspaceFilePreviewResult>();
  const fastB = Promise.withResolvers<WorkspaceFilePreviewResult>();
  const readWorkspaceFile = vi
    .fn()
    .mockReturnValueOnce(slowA.promise)
    .mockReturnValueOnce(fastB.promise);
  vi.stubGlobal("eta", { readWorkspaceFile, openFileTarget: vi.fn() });

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  function Harness() {
    const viewer = useFileViewer({
      workspaceId: "ws-1",
      connectionKey: "local:tab1",
      onOpen: () => {},
    });
    return createElement(
      ToastProvider,
      null,
      createElement(
        "button",
        { type: "button", "data-open": "a", onClick: () => viewer.open({ path: "a.ts" }) },
        "Open A",
      ),
      createElement(
        "button",
        { type: "button", "data-open": "b", onClick: () => viewer.open({ path: "bin.dat" }) },
        "Open B",
      ),
      viewer.active &&
        createElement(InspectorTabs, {
          value: "files",
          onChange: () => {},
          files: createElement(FileViewerPanel, {
            tabs: viewer.tabs,
            active: viewer.active,
            refreshRevision: viewer.refreshRevision,
            onSelect: viewer.select,
            onClose: viewer.close,
            onRefresh: viewer.refresh,
            editors: [],
            cloud: false,
          }),
        }),
    );
  }

  await act(async () => root!.render(createElement(Harness)));
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-open="a"]')?.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-open="b"]')?.click();
  });

  await act(async () => {
    fastB.resolve({
      status: "unavailable",
      reason: "binary",
      absolutePath: "/repo/bin.dat",
      displayPath: "bin.dat",
    });
  });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Binary files cannot be previewed here.",
  );

  // Stale completion for tab A must not overwrite tab B.
  await act(async () => {
    slowA.resolve({
      status: "ready",
      absolutePath: "/repo/a.ts",
      displayPath: "a.ts",
      name: "a.ts",
      content: "stale a",
      truncated: false,
      totalLines: 1,
      size: 7,
    });
  });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Binary files cannot be previewed here.",
  );
  expect(container.textContent).not.toContain("stale a");
});
