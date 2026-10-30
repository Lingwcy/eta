// @vitest-environment jsdom
import { act, createElement, Fragment, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { WorkspaceChanges } from "@eta/core/shared/diff";
import { i18n } from "@/i18n";
import { InspectorTabs, type InspectorContent } from "@/components/inspector/inspector-tabs";
import { DesktopInspector } from "@/components/inspector/desktop-inspector";
import { useCodeDiff } from "./use-code-diff";

let root: Root;
const changes = (names: string[] = []): WorkspaceChanges => ({
  status: "ready",
  workspaceId: "workspace",
  scope: "all",
  revision: "revision",
  files: names.map((path) => ({ id: path, path, kind: "modified", staged: true, unstaged: false })),
});
const api = { workspaceChanges: vi.fn(async () => changes()) };
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  api.workspaceChanges.mockReset().mockResolvedValue(changes());
  Object.defineProperty(window, "eta", { configurable: true, value: api });
  await i18n.changeLanguage("en");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Harness({
  workspaceId = "workspace",
  connectionKey = "view-A",
  revision = 0,
  supported = true,
  others = true,
}: {
  workspaceId?: string | null;
  connectionKey?: string;
  revision?: number;
  supported?: boolean;
  others?: boolean;
}) {
  const [content, setContent] = useState<InspectorContent>("github");
  const diff = useCodeDiff({
    workspaceId: workspaceId ?? undefined,
    threadId: "thread",
    connectionKey,
    revision,
    supported,
    onOpen: () => setContent("diff"),
  });
  return createElement(
    Fragment,
    null,
    diff.canOpenHistory &&
      createElement(
        "button",
        {
          onClick: () =>
            diff.open({
              threadId: "thread",
              workspaceId: workspaceId ?? undefined,
              changeId: "saved",
              path: "saved.ts",
            }),
        },
        "Saved modification",
      ),
    (others || diff.available) &&
      createElement(DesktopInspector, {
        open: true,
        children: createElement(InspectorTabs, {
          value: content,
          onChange: setContent,
          github: others ? "GitHub content" : undefined,
          diff: diff.available
            ? createElement(
                "div",
                null,
                diff.history ? "Saved history" : "Current changes",
                createElement("button", { onClick: diff.showWorkspace }, "Current file"),
              )
            : undefined,
        }),
      }),
  );
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => root.render(createElement(Harness, props)));
}
function diffTab() {
  return document.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Code diff"]');
}
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );
  if (!button) throw new Error("Missing button " + text);
  await act(async () => button.click());
}
async function focus() {
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test.each(["missing", "not-repository", "empty"] as const)(
  "%s workspace has no Diff icon, module or sidebar toggle capability",
  async (state) => {
    if (state === "not-repository")
      api.workspaceChanges.mockResolvedValue({
        status: "not-repository",
        workspaceId: "workspace",
      });
    await render({ workspaceId: state === "missing" ? null : "workspace", others: false });
    expect(diffTab()).toBeNull();
    expect(document.querySelector("#desktop-inspector")).toBeNull();
    expect(api.workspaceChanges).toHaveBeenCalledTimes(state === "missing" ? 0 : 1);
  },
);

test("focus finds new changes and clearing them removes the selected module and falls back to GitHub", async () => {
  await render();
  expect(diffTab()).toBeNull();
  api.workspaceChanges.mockResolvedValue(changes(["example.ts"]));
  await focus();
  expect(diffTab()).not.toBeNull();
  await act(async () => diffTab()!.click());
  expect(document.body.textContent).toContain("Current changes");
  const pending = deferred<WorkspaceChanges>();
  api.workspaceChanges.mockImplementationOnce(() => pending.promise);
  await focus();
  expect(diffTab()).not.toBeNull();
  await act(async () => pending.reject(new Error("temporary read failure")));
  expect(diffTab()).not.toBeNull();
  api.workspaceChanges.mockResolvedValue(changes());
  await focus();
  expect(diffTab()).toBeNull();
  expect(
    [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find((panel) => !panel.hidden)
      ?.textContent,
  ).toBe("GitHub content");
});

test("saved history opens without a workspace or current changes, and leaving it removes the empty module", async () => {
  await render({ workspaceId: null });
  expect(diffTab()).toBeNull();
  await click("Saved modification");
  expect(diffTab()).not.toBeNull();
  expect(document.body.textContent).toContain("Saved history");
  expect(api.workspaceChanges).not.toHaveBeenCalled();
  await click("Current file");
  expect(diffTab()).toBeNull();
});

test("unsupported and disconnected providers expose neither current nor historical entry points", async () => {
  api.workspaceChanges.mockResolvedValue(changes(["example.ts"]));
  await render({ supported: false, others: false });
  expect(document.body.textContent).not.toContain("Saved modification");
  expect(diffTab()).toBeNull();
  expect(api.workspaceChanges).not.toHaveBeenCalled();
  await render({ supported: true });
  expect(diffTab()).not.toBeNull();
  await render({ supported: false });
  expect(diffTab()).toBeNull();
});

test("late results from a previous same-workspace view cannot restore its icon or files", async () => {
  const previous = deferred<WorkspaceChanges>();
  api.workspaceChanges.mockImplementationOnce(() => previous.promise);
  await render();
  await render({ connectionKey: "view-B" });
  await act(async () => previous.resolve(changes(["stale.ts"])));
  expect(diffTab()).toBeNull();
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
});

test("tool completions coalesce while hidden and an old view cannot refresh its replacement", async () => {
  await render();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await render({ revision: 1 });
  await act(async () => vi.advanceTimersByTimeAsync(50));
  await render({ revision: 2 });
  await act(async () => vi.advanceTimersByTimeAsync(99));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(1);
  api.workspaceChanges.mockResolvedValue(changes(["new.ts"]));
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(diffTab()).not.toBeNull();
  expect(api.workspaceChanges).toHaveBeenCalledTimes(2);
  await render({ revision: 3 });
  await render({ connectionKey: "view-B", revision: 0 });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(api.workspaceChanges).toHaveBeenCalledTimes(3);
});
