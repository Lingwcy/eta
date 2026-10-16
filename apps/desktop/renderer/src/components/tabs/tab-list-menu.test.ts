// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DesktopTabs } from "@/agent/desktop-tabs";
import type { TabPresentation } from "@/agent/tab-presentations";
import { TabListMenu } from "./tab-list-menu";

let root: Root;
let tabs: DesktopTabs;
let onSelect: (id: string) => void;

const presentations: TabPresentation[] = [
  {
    id: "conversation",
    kind: "conversation",
    title: "Active conversation",
    subtitle: "Eta",
    text: "Active",
  },
  {
    id: "browser",
    kind: "browser",
    title: "A browser tab",
    subtitle: "example.com",
    text: "Browser",
  },
  {
    id: "settings",
    kind: "settings",
    title: "Settings tab",
    subtitle: "Eta",
    text: "Settings",
  },
  {
    id: "long",
    kind: "conversation",
    title: "A very long conversation title that should truncate inside the scrollable tab list",
    subtitle: "Eta",
    text: "Long title",
  },
];

function Harness() {
  const [open, setOpen] = useState(false);
  return createElement(TabListMenu, {
    tabs,
    items: presentations,
    open,
    onOpenChange: setOpen,
    onSelect,
    triggerId: "tab-list-trigger",
  });
}

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
  vi.stubGlobal(
    "IntersectionObserver",
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
  let id = 0;
  tabs = new DesktopTabs(() => `new-${++id}`, {
    tabs: [
      {
        id: "conversation",
        kind: "conversation",
        threadId: "thread-1",
        workspaceId: "workspace-1",
        draft: "",
      },
      { id: "browser", kind: "browser", url: "https://example.com", title: "Example" },
      { id: "settings", kind: "settings" },
      {
        id: "long",
        kind: "conversation",
        threadId: "thread-2",
        workspaceId: "workspace-1",
        draft: "",
      },
    ],
    activeId: "conversation",
  });
  onSelect = vi.fn<(id: string) => void>();
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

async function renderMenu() {
  await act(async () => root.render(createElement(Harness)));
}

function trigger() {
  return document.querySelector<HTMLButtonElement>('button[aria-label="标签列表"]')!;
}

async function openMenu() {
  await act(async () => trigger().click());
}

function item(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) =>
    node.textContent?.includes(label),
  )!;
}

async function clickItem(label: string) {
  await act(async () => item(label).click());
}

test("the controlled menu opens, exposes top-level actions and routes each action", async () => {
  const newConversation = vi.spyOn(tabs, "newConversation");
  const newBrowser = vi.spyOn(tabs, "newBrowser");
  const openSettings = vi.spyOn(tabs, "openSettings");
  const reopen = vi.spyOn(tabs, "reopen");

  await renderMenu();
  expect(document.querySelector('[role="menu"]')).toBeNull();

  await openMenu();
  expect(document.querySelector('[role="menu"][aria-label="标签操作"]')).not.toBeNull();
  expect(item("重新打开关闭的标签").getAttribute("aria-disabled")).toBe("true");
  await act(async () => item("重新打开关闭的标签").click());
  expect(reopen).not.toHaveBeenCalled();

  await clickItem("新聊天");
  expect(newConversation).toHaveBeenCalledTimes(1);
  await openMenu();
  await clickItem("新网页标签");
  expect(newBrowser).toHaveBeenCalledTimes(1);
  await openMenu();
  await clickItem("设置");
  expect(openSettings).toHaveBeenCalledTimes(1);
});

test("the menu selects tabs, marks the active one and keeps long titles in the inner scroller", async () => {
  await renderMenu();
  await openMenu();

  const popup = document.querySelector<HTMLElement>('[role="menu"][aria-label="标签操作"]')!;
  expect(popup.className).toContain("w-64");
  const scroller = popup.querySelector<HTMLElement>(".max-h-\\[45vh\\]");
  expect(scroller).not.toBeNull();
  expect(scroller!.className).toContain("overflow-y-auto");

  const active = item("Active conversation");
  expect(active.textContent).toContain("当前");
  const longTitle = [...popup.querySelectorAll<HTMLElement>(".truncate")].find((node) =>
    node.textContent?.includes("very long conversation title"),
  );
  expect(longTitle).not.toBeUndefined();

  await clickItem("A browser tab");
  expect(onSelect).toHaveBeenCalledWith("browser");
});

test("the menu supports ArrowDown, Enter and Escape keyboard interactions", async () => {
  const newBrowser = vi.spyOn(tabs, "newBrowser");
  await renderMenu();
  const button = trigger();
  await act(async () => {
    button.focus();
    button.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="menu"][aria-label="标签操作"]')).not.toBeNull();

  const firstItem = document.activeElement as HTMLElement;
  expect(firstItem.getAttribute("role")).toBe("menuitem");
  await act(async () => {
    firstItem.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }),
    );
  });
  expect(document.activeElement?.textContent).toContain("新网页标签");
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
    );
  });
  expect(newBrowser).toHaveBeenCalledTimes(1);

  await openMenu();
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  const popup = document.querySelector<HTMLElement>('[role="menu"][aria-label="标签操作"]');
  expect(popup === null || popup.hasAttribute("data-closed")).toBe(true);
});

test("reopening a closed tab is enabled only when there is a closed tab", async () => {
  tabs.close("settings");
  const reopen = vi.spyOn(tabs, "reopen");
  await renderMenu();
  await openMenu();
  const reopenItem = item("重新打开关闭的标签");
  expect(reopenItem.getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => reopenItem.click());
  expect(reopen).toHaveBeenCalledTimes(1);
});
