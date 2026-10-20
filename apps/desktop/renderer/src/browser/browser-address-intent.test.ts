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
  navigation: string[] = [];
  constructor(readonly id: string) {}
  state() {
    return {
      id: this.id,
      url: this.navigation.at(-1) ?? "",
      title: "Fixture page",
      loading: false,
      canGoBack: this.navigation.length > 1,
      canGoForward: false,
    };
  }
  load = async (url: string) => {
    this.navigation.push(url);
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
let holds: BrowserCommand[];
let release: ReturnType<typeof Promise.withResolvers<void>>;
let holdCreate = false;
const tab: BrowserTab = { id: "web", kind: "browser", url: "", title: "" };
let view: ReturnType<typeof useBrowserPage>;

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
  holds = [];
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
        holds.push(command);
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
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  view = useBrowserPage(tab, true, client, state[tab.id]);
  return createElement("div", { ref: view.viewport });
}

async function mount() {
  await act(async () => root.render(createElement(Host)));
}
async function submit(address: string) {
  await act(async () => view.setAddress(address));
  await act(async () => void view.navigate());
}

test("an address submitted while the page is still being created wins", async () => {
  holdCreate = true;
  await mount();
  await submit("first.example");
  await expect.poll(() => holds.length).toBe(1);
  await submit("second.example");
  // The later address waits for the first page instead of being dropped by a second create.
  expect(holds.length).toBe(1);
  await act(async () => release.resolve());
  await expect.poll(() => pages.get("web")?.state().url).toBe("https://second.example/");
  expect(pages.get("web")?.navigation).toEqual([
    "https://first.example/",
    "https://second.example/",
  ]);
});

test("a single address still creates the page exactly once", async () => {
  await mount();
  await submit("only.example");
  await expect.poll(() => pages.get("web")?.navigation.length).toBe(1);
  expect(pages.get("web")?.navigation).toEqual(["https://only.example/"]);
});
