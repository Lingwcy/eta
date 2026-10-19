// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { AgentBridge, AgentEvent, DesktopLibrary } from "../../../src/bridge.ts";
import type { SessionResponse } from "@eta/core/agent/protocol";
import type { DesktopLibraryController } from "./use-desktop-library";
import { DesktopTabs } from "./desktop-tabs";
import { ThreadActivity } from "./thread-activity";
import { ThreadRecents } from "./thread-recents";
import { useDesktopController } from "./use-desktop-controller";
import { i18n } from "@/i18n";

const cloudId = "bot:test:thread";
const localId = "local-thread";
const model = {
  provider: "test",
  id: "one",
  name: "Test model",
  contextWindow: 100_000,
  thinkingLevels: ["off", "high"] as const,
};
function session(id: string, text = "Earlier history"): SessionResponse {
  return {
    id,
    model: { ...model, thinkingLevels: [...model.thinkingLevels] },
    contextTokens: 12,
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [
        { id: "user-1", type: "message", message: { role: "user", content: text, timestamp: 0 } },
      ],
      operation: null,
      lastResult: null,
      faulted: false,
    },
  };
}
function library(status: "connected" | "error", message?: string): DesktopLibrary {
  return {
    projects: [],
    workspaces: [],
    threads: [],
    credentials: [],
    providers: [],
    models: [model],
    settings: { defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off" },
    bot: {
      status,
      url: "https://bot.example",
      ...(message ? { message } : {}),
      library: {
        projects: [],
        workspaces: [],
        threads: [],
        models: [model],
        settings: { defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off" },
      },
    },
  };
}

let root: Root;
let openThread: ReturnType<typeof vi.fn>;
let bridge: AgentBridge;
let failOpen = 0;

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
  await i18n.changeLanguage("en");
  openThread = vi.fn(async (id: string) => {
    if (failOpen > 0) {
      failOpen--;
      throw new Error("Bot is unreachable");
    }
    return session(id);
  });
  bridge = {
    openThread,
    subscribe: (_id: string, _listener: (event: AgentEvent) => void) => () => {},
    submit: async () => ({ operationId: "operation", kind: "run", startedAt: 0 }),
    stop: async () => {},
  } as unknown as AgentBridge;
  vi.stubGlobal("eta", bridge);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

/** Mounts the real controller for one conversation and lets the test swap catalog health. */
async function mount(threadId: string | undefined, initial: DesktopLibrary, cloudDraft = false) {
  const tabs = new DesktopTabs();
  if (threadId) tabs.openThread(threadId, "workspace");
  if (cloudDraft) tabs.updateConversation(tabs.activeTab.id, { environment: "cloud" });
  const activity = new ThreadActivity(bridge);
  const recents = new ThreadRecents({ getItem: () => null, setItem: () => {} });
  let view: ReturnType<typeof useDesktopController> | undefined;
  function Host({ library: current }: { library: DesktopLibrary }) {
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const tab = tabs.activeTab;
    if (tab.kind !== "conversation") throw new Error("Expected a conversation tab");
    const desktop = {
      library: current,
      error: null,
      busy: false,
      mainModel: undefined,
      selectMainModel: () => {},
      refresh: async () => current,
      reload: () => {},
      act: async (work: () => Promise<void>) => {
        await work();
      },
      updateSettings: async () => {},
      clearError: () => {},
    } satisfies DesktopLibraryController;
    view = useDesktopController(
      tab,
      desktop,
      {
        tabs,
        state,
        activity,
        visits: recents.getSnapshot(),
        runningThreadIds: new Set(),
        recordInput: recents.recordInput,
      },
      true,
      0,
    );
    return null;
  }
  const render = (next: DesktopLibrary) =>
    act(async () => root.render(createElement(Host, { library: next })));
  await render(initial);
  return {
    view: () => view!,
    status: (next: DesktopLibrary) => render(next),
    history: () => view?.transcript.snapshot?.transcript.length,
  };
}

test("a catalog poll error neither disables a healthy cloud chat nor reloads its history on recovery", async () => {
  const mounted = await mount(cloudId, library("connected"));
  expect(openThread).toHaveBeenCalledOnce();
  expect(mounted.history()).toBe(1);
  expect(mounted.view().composer.disabled).toBe(false);

  await mounted.status(library("error", "Bot directory read failed"));
  expect(mounted.view().composer.disabled).toBe(false);
  expect(mounted.history()).toBe(1);
  expect(openThread).toHaveBeenCalledOnce();

  await mounted.status(library("connected"));
  expect(openThread).toHaveBeenCalledOnce();
  expect(mounted.history()).toBe(1);
  expect(mounted.view().composer.disabled).toBe(false);
});

test("catalog recovery still rebuilds an observation that never connected", async () => {
  failOpen = 1;
  const mounted = await mount(cloudId, library("connected"));
  expect(openThread).toHaveBeenCalledOnce();
  expect(mounted.history()).toBeUndefined();
  expect(mounted.view().composer.disabled).toBe(true);

  await mounted.status(library("error", "Bot directory read failed"));
  await mounted.status(library("connected"));
  expect(openThread).toHaveBeenCalledTimes(2);
  expect(mounted.history()).toBe(1);
  expect(mounted.view().composer.disabled).toBe(false);
});

test("a cloud draft without a live observation stays gated while the catalog is unavailable", async () => {
  const mounted = await mount(undefined, library("connected"), true);
  expect(mounted.view().composer.disabled).toBe(false);

  await mounted.status(library("error", "Bot directory read failed"));
  expect(mounted.view().composer.disabled).toBe(true);

  await mounted.status(library("connected"));
  expect(mounted.view().composer.disabled).toBe(false);
});

test("catalog health does not gate or reload a local conversation", async () => {
  const mounted = await mount(localId, library("connected"));
  expect(openThread).toHaveBeenCalledOnce();
  expect(mounted.history()).toBe(1);

  await mounted.status(library("error", "Bot directory read failed"));
  expect(mounted.view().composer.disabled).toBe(false);
  expect(mounted.history()).toBe(1);

  await mounted.status(library("connected"));
  expect(openThread).toHaveBeenCalledOnce();
  expect(mounted.history()).toBe(1);
});
