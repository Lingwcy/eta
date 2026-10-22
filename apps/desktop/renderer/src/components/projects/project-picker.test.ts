// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProjectPicker } from "./project-picker";
import type { DesktopLibrary } from "../../../../src/bridge.ts";

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
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
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
    (element) => element.getAttribute("aria-label") === label || element.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

test("project selection can be searched, cleared from both entry points and selected again", async () => {
  const library: DesktopLibrary = {
    projects: [
      { id: "eta", name: "eta", rootPath: "/eta", environmentId: "local", createdAt: 0 },
      { id: "other", name: "other", rootPath: "/other", environmentId: "local", createdAt: 0 },
    ],
    workspaces: [
      { id: "eta-root", projectId: "eta", kind: "project-root", cwd: "/eta", createdAt: 0 },
      { id: "other-root", projectId: "other", kind: "project-root", cwd: "/other", createdAt: 0 },
      { id: "temporary", projectId: null, kind: "temporary", cwd: "/temporary", createdAt: 0 },
    ],
    threads: [],
    settings: { defaultThinkingLevel: "off" },
    models: [],
    providers: [],
    credentials: [],
  };
  let selected: string | null = null;
  function Draft() {
    const [workspaceId, setWorkspaceId] = useState<string | null>(null);
    return createElement(ProjectPicker, {
      library,
      workspaceId,
      projectName:
        workspaceId === "eta-root" ? "eta" : workspaceId === "other-root" ? "other" : undefined,
      disabled: false,
      onSelect: (id) => {
        selected = id;
        setWorkspaceId(id);
      },
      onCreate: async () => {},
    });
  }
  await act(async () => root.render(createElement(Draft)));
  await click("选择项目");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="搜索项目"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "eta");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const options = document.querySelectorAll<HTMLElement>('[role="option"]');
  expect(options).toHaveLength(1);
  await act(async () => options[0].click());
  expect(selected).toBe("eta-root");
  await click("不在项目中工作");
  expect(selected).toBeNull();
  await click("选择项目");
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((element) => element.textContent === "other")!
      .click(),
  );
  expect(selected).toBe("other-root");
  await click("更改此聊天的项目");
  await click("不在项目中工作");
  expect(selected).toBeNull();
  await click("选择项目");
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);
});
