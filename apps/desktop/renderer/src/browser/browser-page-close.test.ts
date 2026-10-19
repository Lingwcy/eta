// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { BrowserClient } from "./client";
import { useBrowserPage } from "./use-browser-page";
import type { BrowserTab } from "@/agent/desktop-tabs";
import { BrowserManager, type BrowserPage } from "../../../src/main/browser/manager.ts";
import type { BrowserCommand, BrowserEvent } from "../../../src/browser/protocol.ts";

class Page implements BrowserPage {
  closed = false;
  shown = false;
  url = "";
  constructor(readonly id: string) {}
  state() {
    return {
      id: this.id,
      url: this.url,
      title: "Fixture page",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
  }
  load = async (url: string) => {
    this.url = url;
  };
  back() {}
  forward() {}
  reload() {}
  stop() {}
  bounds() {}
  visible(value: boolean) {
    this.shown = value;
  }
  capture = async () => undefined;
  close() {
    this.closed = true;
  }
}

let root: Root;
let manager: BrowserManager;
let client: BrowserClient;
let pages: Map<string, Page>;
let release: ReturnType<typeof Promise.withResolvers<void>>;
let held: BrowserCommand[];
let holdCreate = false;
const tab: BrowserTab = { id: "web", kind: "browser", url: "https://example.com/", title: "" };

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
  holdCreate = false;
  held = [];
  release = Promise.withResolvers();
  pages = new Map();
  manager = new BrowserManager(
    (id) => {
      const page = new Page(id);
      pages.set(id, page);
      return page;
    },
    () => {},
  );
  const bridge = {
    browser: async (command: BrowserCommand) => {
      if (holdCreate && command.type === "create") {
        held.push(command);
        await release.promise;
      }
      return manager.command(command);
    },
    subscribeBrowser: (_listener: (event: BrowserEvent) => void) => () => {},
  };
  client = new BrowserClient(bridge as never);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  release.resolve();
  await act(async () => root.unmount());
  manager.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Host() {
  const pagesState = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const page = useBrowserPage(tab, true, client, pagesState[tab.id]);
  return createElement("div", { ref: page.viewport });
}

async function mount() {
  await act(async () => root.render(createElement(Host)));
}

test("closing a tab while its page is still being created does not leave the page behind", async () => {
  holdCreate = true;
  await mount();
  await expect.poll(() => held.length).toBe(1);
  await act(async () => root.render(createElement("div")));
  await act(async () => release.resolve());
  await expect.poll(() => pages.get("web")?.closed ?? true).toBe(true);
});

test("a page created after its tab was reopened stays usable", async () => {
  holdCreate = true;
  await mount();
  await expect.poll(() => held.length).toBe(1);
  await act(async () => root.render(createElement("div")));
  await mount();
  await act(async () => release.resolve());
  await expect.poll(() => pages.has("web")).toBe(true);
  expect(pages.get("web")?.closed).toBe(false);
});
