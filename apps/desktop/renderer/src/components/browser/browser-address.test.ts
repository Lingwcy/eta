// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BrowserPanel } from "./browser-panel";
import { DesktopTabs } from "@/agent/desktop-tabs";
import { useBrowserPages } from "@/browser/use-browser-pages";
import type { BrowserClient } from "@/browser/client";
import { BrowserManager, type BrowserPage } from "../../../../src/main/browser/manager.ts";
import type { BrowserEvent } from "../../../../src/browser/protocol.ts";
import { ToastProvider } from "@/components/ui/toast";
import { i18n } from "@/i18n";

let root: Root;
let manager: BrowserManager;
let tabs: DesktopTabs;
let client: BrowserClient | undefined;
let pages: Map<string, BrowserPage>;
let oldLanguage: string;
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
const noop = () => {};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  oldLanguage = i18n.language;
  await i18n.changeLanguage("en");
  const listeners = new Set<(event: BrowserEvent) => void>();
  pages = new Map();
  manager = new BrowserManager(
    (id, changed) => {
      let url = "";
      const page: BrowserPage = {
        state: () => ({
          id,
          url,
          title: "Fixture page",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        }),
        load: async (value) => {
          url = value;
          changed();
        },
        back() {},
        forward() {},
        reload() {},
        stop() {},
        bounds() {},
        visible() {},
        close() {},
        capture: async () => undefined,
      };
      pages.set(id, page);
      return page;
    },
    (event) => {
      for (const listener of listeners) listener(event);
    },
  );
  vi.stubGlobal("eta", {
    browser: manager.command.bind(manager),
    subscribeBrowser: (listener: (event: BrowserEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let next = 0;
  tabs = new DesktopTabs(() => "tab-" + ++next);
  client = undefined;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  manager.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  if (originalAnimations)
    Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  await i18n.changeLanguage(oldLanguage);
});
async function open(mode: "create" | "navigate") {
  const id = tabs.newBrowser(mode === "create" ? "" : "https://initial.example/");
  function Host() {
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const browser = useBrowserPages(tabs, state, noop);
    client = browser.client;
    const tab = state.tabs.find((entry) => entry.id === id);
    if (tab?.kind !== "browser") throw new Error("Browser tab missing");
    return createElement(BrowserPanel, {
      tab,
      tabs,
      client: browser.client,
      state: browser.pages[id],
      visible: true,
    });
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Host))));
  return id;
}
async function enter(value: string) {
  const input = document.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  return input;
}
const addresses = [
  ["localhost?mode=preview", "http://localhost/?mode=preview"],
  ["localhost#debug", "http://localhost/#debug"],
  ["localhost:5173?mode=preview", "http://localhost:5173/?mode=preview"],
  ["localhost:5173#debug", "http://localhost:5173/#debug"],
  ["127.0.0.1:8080?x=1", "http://127.0.0.1:8080/?x=1"],
  ["example.com:8080?x=1", "https://example.com:8080/?x=1"],
  ["example.com:8080#debug", "https://example.com:8080/#debug"],
  ["LOCALHOST:5173/path", "http://localhost:5173/path"],
  ["LOCALHOST:443?x=1", "http://localhost:443/?x=1"],
  ["[::1]?x=1", "https://[::1]/?x=1"],
  ["[::1]:5173#debug", "https://[::1]:5173/#debug"],
  ["localhost.evil.example/path", "https://localhost.evil.example/path"],
  ["localhostexample.com/path", "https://localhostexample.com/path"],
  ["127.example.com/path", "https://127.example.com/path"],
  ["localhost:80/path", "http://localhost/path"],
  ["127.1/path", "http://127.0.0.1/path"],
  ["example.com/path?x=1", "https://example.com/path?x=1"],
  ["example.com:80/path", "https://example.com:80/path"],
  ["http://public.example/?x=1", "http://public.example/?x=1"],
  ["https://localhost:443/?x=1", "https://localhost/?x=1"],
  ["find browser docs", "https://duckduckgo.com/?q=find%20browser%20docs"],
] as const;
const cases = (["create", "navigate"] as const).flatMap((mode) =>
  addresses.map(([input, expected]) => ({ mode, input, expected })),
);
test.each(cases)("browser address $mode: $input", async ({ mode, input, expected }) => {
  const id = await open(mode);
  const field = await enter(input);
  expect(pages.get(id)?.state().url).toBe(expected);
  expect(field.value).toBe(expected);
  expect(client?.getSnapshot()[id]?.error).toBeUndefined();
  expect(tabs.activeTab).toMatchObject({ url: expected });
});
test.each(
  (["create", "navigate"] as const).flatMap((mode) =>
    [
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///etc/passwd",
      "ftp://example.com",
      "custom://example.com",
    ].map((input) => ({ mode, input })),
  ),
)("browser address $mode refuses $input before load", async ({ mode, input }) => {
  const id = await open(mode);
  await enter(input);
  expect(pages.get(id)?.state().url).toBe(
    mode === "create" ? undefined : "https://initial.example/",
  );
  expect(client?.getSnapshot()[id]?.error).toBeDefined();
  expect(document.body.textContent).toContain(
    i18n.t("browser:browserPanel.thePageCouldNotBeLoaded"),
  );
});
