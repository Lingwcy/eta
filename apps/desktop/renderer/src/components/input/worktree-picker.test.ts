// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GitRepositoryInfo } from "@eta/core/shared/git";
import { WorktreePicker, type WorktreeDraft } from "./worktree-picker";

const repository = {
  status: "ready",
  workspaceId: "workspace",
  root: "/project",
  gitDir: "/project/.git",
  commonDir: "/project/.git",
  prefix: "",
  linkedWorktree: false,
  head: { kind: "branch", name: "main", sha: "a" },
  remotes: [],
  changes: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
} satisfies GitRepositoryInfo;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom does not implement the animation API used to measure ScrollArea.
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal("eta", {
    gitRepository: vi.fn().mockResolvedValue(repository),
    gitBranches: vi.fn().mockResolvedValue([
      { name: "main", kind: "local", current: true, sha: "a" },
      { name: "feature", kind: "local", current: false, sha: "b" },
      { name: "origin/main", kind: "remote", current: false, sha: "a" },
    ]),
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("opening grouped branches, searching, selecting and reopening keeps the picker usable", async () => {
  const change = vi.fn();
  function Draft() {
    const [draft, setDraft] = useState<WorktreeDraft>({ enabled: false });
    return createElement(WorktreePicker, {
      workspaceId: "workspace",
      worktree: false,
      disabled: false,
      draft,
      onChange: (next) => {
        change(next);
        setDraft(next);
      },
    });
  }
  await act(async () => root.render(createElement(Draft)));
  await click("配置工作区");
  await click("分支");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索分支"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "feature",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const options = document.querySelectorAll<HTMLElement>('[role="option"]');
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toBe("feature");
  await act(async () => options[0].click());
  expect(change).toHaveBeenLastCalledWith({
    enabled: true,
    branch: { kind: "existing", name: "feature" },
  });
  await click("分支");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
  expect(document.querySelector<HTMLInputElement>('input[aria-label="搜索分支"]')!.value).toBe("");
  expect(document.querySelector('button[aria-label="配置工作区"]')).not.toBeNull();
  await click("创建并检出新分支");
  const name = document.querySelector<HTMLInputElement>('input[aria-label="新分支名称"]')!;
  expect(name).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      name,
      "feature-next",
    );
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(change).toHaveBeenLastCalledWith({
    enabled: true,
    branch: { kind: "new", name: "feature-next", baseRef: "feature" },
  });
  await click("分支");
  expect(document.querySelector('input[aria-label="新分支名称"]')).toBeNull();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
});
