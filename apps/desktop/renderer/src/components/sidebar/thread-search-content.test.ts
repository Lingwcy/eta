// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { Dialog } from "@/components/ui/dialog";
import { i18n } from "@/i18n";
import type { SearchDialogProps } from "./search-dialog-props";
import { ThreadSearchContent } from "./thread-search-content";

const roots: Root[] = [];

beforeEach(async () => {
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
  await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  await i18n.changeLanguage("zh-CN");
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  vi.unstubAllGlobals();
});

async function renderSearch() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const props: SearchDialogProps & { onClose: () => void } = {
    library: null,
    archived: false,
    busy: false,
    canCreate: true,
    runningThreadIds: new Set<string>(),
    onSelect: () => {},
    onNew: () => {},
    onChoose: () => {},
    onSkills: () => {},
    onClose: () => {},
  };
  await act(async () => {
    root.render(createElement(Dialog, { open: true }, createElement(ThreadSearchContent, props)));
  });
  return container;
}

function searchInput() {
  const input = document.querySelector<HTMLInputElement>("input");
  expect(input).not.toBeNull();
  return input!;
}

function actionLabels() {
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (option) => option.querySelector<HTMLElement>("span.flex-1")?.textContent?.trim() ?? "",
  );
}

async function setQuery(query: string) {
  const input = searchInput();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

test.each([
  ["New", "New chat"],
  ["new", "New chat"],
  ["Open", "Open folder"],
  ["open", "Open folder"],
  ["Skill", "Skill settings"],
  ["skill", "Skill settings"],
  ["  new  ", "New chat"],
])("English quick actions match %j case-insensitively", async (query, expected) => {
  await act(async () => i18n.changeLanguage("en"));
  await renderSearch();
  await setQuery(query);
  expect(actionLabels()).toEqual([expected]);
});

test("empty and whitespace queries keep every English quick action visible", async () => {
  await act(async () => i18n.changeLanguage("en"));
  await renderSearch();
  expect(actionLabels()).toEqual(["Skill settings", "New chat", "Open folder"]);
  await setQuery("   ");
  expect(actionLabels()).toEqual(["Skill settings", "New chat", "Open folder"]);
});

test("quick-action filtering follows locale changes without resetting the query", async () => {
  await renderSearch();
  const input = await setQuery("new");
  expect(actionLabels()).toEqual([]);

  await act(async () => i18n.changeLanguage("en"));
  expect(searchInput()).toBe(input);
  expect(input.value).toBe("new");
  expect(actionLabels()).toEqual(["New chat"]);

  await act(async () => i18n.changeLanguage("zh-CN"));
  expect(input.value).toBe("new");
  expect(actionLabels()).toEqual([]);
});
