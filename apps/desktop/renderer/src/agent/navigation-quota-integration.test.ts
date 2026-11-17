// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { AgentEvent, DesktopLibrary } from "../../../src/bridge.ts";
import type { AgentModel, SessionResponse } from "@eta/core/agent/protocol";
import { i18n } from "@/i18n";
import { ActionToolbar } from "@/components/input/action-toolbar";
import { NavigationRail } from "@/components/sidebar/navigation-rail";
import { DesktopTabs, type ConversationTab } from "./desktop-tabs";
import { ThreadActivity } from "./thread-activity";
import { ThreadRecents } from "./thread-recents";
import { useDesktopController } from "./use-desktop-controller";
import { useDesktopLibrary, type DesktopLibraryController } from "./use-desktop-library";
import type { DesktopTabController } from "./use-desktop-tabs";

const alpha: AgentModel = {
  provider: "openai-codex",
  id: "one",
  name: "Alpha",
  contextWindow: 10000,
  thinkingLevels: ["off"],
};
const beta: AgentModel = {
  provider: "github-copilot",
  id: "two",
  name: "Beta",
  contextWindow: 10000,
  thinkingLevels: ["off"],
};

function session(id: string, model: AgentModel): SessionResponse {
  return {
    id,
    model,
    contextTokens: 0,
    snapshot: {
      configuration: {
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: "off",
      },
      transcript: [],
      operation: null,
      lastResult: null,
      faulted: false,
    },
  };
}

test("current conversation model selects its account quota across retained chats and environments", async () => {
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
  const animations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  await i18n.changeLanguage("en");
  const settings = {
    locale: "en" as const,
    defaultProvider: alpha.provider,
    defaultModel: alpha.id,
    defaultThinkingLevel: "off" as const,
  };
  const library: DesktopLibrary = {
    projects: [],
    workspaces: [],
    threads: [],
    models: [alpha, beta],
    settings,
    providers: [
      { id: alpha.provider, name: "Codex", methods: ["oauth"] },
      { id: beta.provider, name: "Copilot", methods: ["oauth"] },
    ],
    credentials: [
      { providerId: alpha.provider, type: "oauth" },
      { providerId: beta.provider, type: "oauth" },
    ],
    quotaConnections: [
      { providerId: alpha.provider, connectionId: "account-a" },
      { providerId: beta.provider, connectionId: "account-b" },
    ],
    bot: {
      status: "connected",
      url: "https://bot",
      library: { projects: [], workspaces: [], threads: [], models: [alpha], settings },
    },
  };
  const sessions = new Map([
    ["thread-a", session("thread-a", alpha)],
    ["thread-b", session("thread-b", beta)],
    ["bot:test:thread", session("bot:test:thread", alpha)],
  ]);
  const delayed = Promise.withResolvers<SessionResponse>();
  const listeners = new Map<string, (event: AgentEvent) => void>();
  const quota = vi.fn(async (providerId: string, connectionId: string) => ({
    providerId,
    connectionId,
    status: "ready" as const,
    readAt: Date.now(),
    windows: [
      { id: "primary", name: "primary", usedPercent: providerId === alpha.provider ? 25 : 60 },
    ],
  }));
  const bridge = {
    library: async () => library,
    subscribeLibrary: () => () => {},
    updateSettings: async (patch: Partial<typeof settings>) => Object.assign(settings, patch),
    openThread: async (id: string) => (id === "thread-b" ? delayed.promise : sessions.get(id)!),
    subscribe: (id: string, listener: (event: AgentEvent) => void) => {
      listeners.set(id, listener);
      return () => {
        listeners.delete(id);
      };
    },
    subscriptionQuota: quota,
    subscribeUpdate: () => () => {},
    updateState: async () => ({ status: "idle" as const }),
  };
  vi.stubGlobal("eta", bridge);
  let nextId = 0;
  const tabs = new DesktopTabs(() => "tab-" + ++nextId);
  const activity = new ThreadActivity(bridge as never);
  const recents = new ThreadRecents({ getItem: () => null, setItem: () => {} });
  function Conversation({
    tab,
    desktop,
    navigation,
    active,
  }: {
    tab: ConversationTab;
    desktop: DesktopLibraryController;
    navigation: DesktopTabController;
    active: boolean;
  }) {
    const view = useDesktopController(tab, desktop, navigation, active, 0);
    return createElement(
      "div",
      { hidden: !active },
      createElement(ActionToolbar, { ...view.composer, canSubmit: false, onSubmit: () => {} }),
    );
  }
  function Host() {
    const desktop = useDesktopLibrary();
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const navigation: DesktopTabController = {
      tabs,
      state,
      activity,
      visits: recents.getSnapshot(),
      runningThreadIds: new Set(),
      recordInput: recents.recordInput,
    };
    const active = tabs.activeTab;
    const conversation = active.kind === "conversation" ? active : undefined;
    return createElement(
      "div",
      null,
      createElement(NavigationRail, {
        model: desktop.mainModel,
        conversation,
        library: desktop.library,
        onHome: () => {},
        onSettings: () => {},
      }),
      ...state.tabs
        .filter((tab): tab is ConversationTab => tab.kind === "conversation")
        .map((tab) =>
          createElement(Conversation, {
            key: tab.id,
            tab,
            desktop,
            navigation,
            active: tab.id === state.activeId,
          }),
        ),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (selector: string) => {
    const value = document.querySelector<HTMLButtonElement>(selector);
    if (!value) throw new Error("Missing button " + selector);
    return value;
  };
  const focusQuota = async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      button('[aria-label="Subscription usage"]').focus();
    });
  };
  try {
    await act(async () => root.render(createElement(Host)));
    expect(quota).toHaveBeenLastCalledWith(alpha.provider, "account-a", false);
    await focusQuota();
    expect(document.body.textContent).toContain("75% remaining");
    await act(async () => button('[aria-label="Choose a model and thinking level"]').click());
    await act(async () => button('[aria-label="All models"]').click());
    await act(async () => button('[title="github-copilot/two"][aria-pressed]').click());
    expect(quota).toHaveBeenLastCalledWith(beta.provider, "account-b", false);
    await focusQuota();
    expect(document.body.textContent).toContain("40% remaining");
    await act(async () => tabs.updateConversation(tabs.activeTab.id, { draft: "draft" }));
    let first = "";
    await act(async () => {
      first = tabs.openThread("thread-a", "workspace-a");
    });
    expect(quota).toHaveBeenLastCalledWith(alpha.provider, "account-a", false);
    const beforePending = quota.mock.calls.length;
    let second = "";
    await act(async () => {
      second = tabs.openThread("thread-b", "workspace-b");
    });
    expect(container.querySelector('[aria-label="Subscription usage"]')).toBeNull();
    expect(container.querySelector('[aria-label="Eta"]')).not.toBeNull();
    expect(quota).toHaveBeenCalledTimes(beforePending);
    await act(async () => delayed.resolve(sessions.get("thread-b")!));
    expect(quota).toHaveBeenLastCalledWith(beta.provider, "account-b", false);
    const beforeUnknown = quota.mock.calls.length;
    await act(async () =>
      listeners.get("thread-b")?.({
        type: "snapshot",
        value: {
          snapshot: {
            ...sessions.get("thread-b")!.snapshot,
            configuration: {
              model: { provider: beta.provider, modelId: "missing-from-catalog" },
              thinkingLevel: "off",
            },
          },
          contextTokens: 0,
        },
      }),
    );
    expect(quota).toHaveBeenCalledTimes(beforeUnknown + 1);
    expect(quota).toHaveBeenLastCalledWith(beta.provider, "account-b", false);
    const count = quota.mock.calls.length;
    await act(async () =>
      listeners.get("thread-a")?.({
        type: "snapshot",
        value: {
          snapshot: {
            ...sessions.get("thread-a")!.snapshot,
            configuration: {
              model: { provider: beta.provider, modelId: beta.id },
              thinkingLevel: "off",
            },
          },
          contextTokens: 0,
        },
      }),
    );
    expect(tabs.activeTab.id).toBe(second);
    expect(quota).toHaveBeenCalledTimes(count);
    await focusQuota();
    expect(document.body.textContent).toContain("40% remaining");
    await act(async () => tabs.openThread("bot:test:thread", "bot:test:workspace"));
    expect(container.querySelector('[aria-label="Subscription usage"]')).toBeNull();
    expect(container.querySelector('[aria-label="Eta"]')).not.toBeNull();
    expect(quota).toHaveBeenCalledTimes(count);
    await act(async () => tabs.openSettings());
    expect(container.querySelector('[aria-label="Subscription usage"]')).toBeNull();
    expect(container.querySelector('[aria-label="Eta"]')).not.toBeNull();
    await act(async () => tabs.select(first));
    expect(quota).toHaveBeenLastCalledWith(beta.provider, "account-b", false);
  } finally {
    delayed.resolve(sessions.get("thread-b")!);
    await act(async () => root.unmount());
    activity.dispose();
    container.remove();
    localStorage.clear();
    if (animations) Object.defineProperty(HTMLElement.prototype, "getAnimations", animations);
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
    vi.unstubAllGlobals();
    await i18n.changeLanguage("zh-CN");
  }
});
