// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type {
  AgentBridge,
  AgentEvent,
  DesktopBridge,
  DesktopLibrary,
} from "../../../src/bridge.ts";
import type { SessionResponse } from "@eta/core/agent/protocol";
import type { DesktopLibraryController } from "./use-desktop-library";
import { DesktopTabs } from "./desktop-tabs";
import { ThreadActivity } from "./thread-activity";
import { ThreadRecents } from "./thread-recents";
import { useDesktopController } from "./use-desktop-controller";
import { CompositeInput } from "@/components/input";
import { ToastProvider } from "@/components/ui/toast";
import { i18n } from "@/i18n";

const model = {
  provider: "test",
  id: "one",
  name: "Test model",
  contextWindow: 100_000,
  thinkingLevels: ["off", "high"] as const,
};
const library: DesktopLibrary = {
  projects: [],
  workspaces: [
    { id: "workspace", projectId: "project", cwd: "/work", kind: "project-root", createdAt: 0 },
  ],
  threads: [],
  credentials: [],
  providers: [],
  models: [model],
  settings: { defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off" },
};
function session(id: string): SessionResponse {
  return {
    id,
    model: { ...model, thinkingLevels: [...model.thinkingLevels] },
    contextTokens: 0,
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [],
      operation: {
        id: "operation",
        kind: "run",
        startedAt: 1,
        fromTipId: null,
        status: "running",
        runningTools: [],
      },
      lastResult: null,
      faulted: false,
    },
  };
}

let root: Root;
let tabs: DesktopTabs;
type HarnessBridge = AgentBridge & Pick<DesktopBridge, "createThread">;
let bridge: HarnessBridge;
let created: ReturnType<typeof Promise.withResolvers<{ id: string }>>;
let submitted: ReturnType<typeof Promise.withResolvers<never>>;
let stop: ReturnType<typeof vi.fn>;
let view: ReturnType<typeof useDesktopController> | undefined;

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
  created = Promise.withResolvers();
  submitted = Promise.withResolvers();
  stop = vi.fn(async () => {});
  bridge = {
    createThread: vi.fn(async () => created.promise),
    submit: vi.fn(async () => submitted.promise),
    openThread: vi.fn(async (id: string) => session(id)),
    subscribe: (_id: string, _listener: (event: AgentEvent) => void) => () => {},
    stop,
  } as unknown as HarnessBridge;
  vi.stubGlobal("eta", bridge);
  tabs = new DesktopTabs();
  tabs.updateConversation(tabs.activeTab.id, { workspaceId: "workspace" });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  created.resolve({ id: "thread" });
  submitted.reject(new Error("test finished"));
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

async function mount() {
  const activity = new ThreadActivity(bridge);
  const recents = new ThreadRecents({ getItem: () => null, setItem: () => {} });
  const desktop = {
    library,
    error: null,
    busy: false,
    mainModel: undefined,
    selectMainModel: () => {},
    refresh: async () => library,
    reload: () => {},
    act: async (work: () => Promise<void>) => {
      await work();
    },
    updateSettings: async () => {},
    clearError: () => {},
  } satisfies DesktopLibraryController;
  function Host() {
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const tab = tabs.activeTab;
    if (tab.kind !== "conversation") throw new Error("Expected a conversation tab");
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
    return createElement(CompositeInput, view.composer);
  }
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Host))));
}

function button(label: string) {
  return [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === label,
  );
}
const sendLabel = () => i18n.t("chat:actionToolbar.sendMessage");
const stopLabel = () => i18n.t("chat:actionToolbar.stopGeneration");

async function send() {
  const textarea = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Hello",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(sendLabel())!.click());
}

test("a draft shows no stop control until its thread exists, then stops that thread", async () => {
  await mount();
  await send();
  await expect
    .poll(() => (bridge.createThread as ReturnType<typeof vi.fn>).mock.calls.length)
    .toBe(1);
  // Nothing durable exists yet: the composer stays disabled, without a stop affordance.
  expect(view!.composer.isRunning).toBe(false);
  expect(view!.composer.disabled).toBe(true);
  expect(button(stopLabel())).toBeUndefined();
  expect(button(sendLabel())!.disabled).toBe(true);

  await act(async () => created.resolve({ id: "thread" }));
  await expect
    .poll(() => tabs.activeTab.kind === "conversation" && tabs.activeTab.threadId)
    .toBe("thread");
  await expect.poll(() => view!.composer.isRunning).toBe(true);
  const stopButton = button(stopLabel())!;
  expect(stopButton).toBeDefined();
  await act(async () => stopButton.click());
  expect(stop).toHaveBeenCalledWith("thread");
});
