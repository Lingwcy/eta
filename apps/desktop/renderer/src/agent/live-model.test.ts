// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { AgentBridge, AgentEvent, DesktopLibrary } from "../../../src/bridge.ts";
import type { AgentModel, SessionResponse, ThinkingLevel } from "@eta/core/agent/protocol";
import type { DesktopLibraryController } from "./use-desktop-library";
import { DesktopTabs } from "./desktop-tabs";
import { ThreadActivity } from "./thread-activity";
import { ThreadRecents } from "./thread-recents";
import { useDesktopController } from "./use-desktop-controller";
import { ActionToolbar } from "@/components/input/action-toolbar";
import { i18n } from "@/i18n";

function button(selector: string) {
  const value = document.querySelector<HTMLButtonElement>(selector);
  if (!value) throw new Error("Missing button " + selector);
  return value;
}

test.each(["local", "cloud", "collision", "unknown", "same", "session-only"] as const)(
  "live model metadata: %s",
  async (mode) => {
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
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    Object.defineProperty(HTMLElement.prototype, "getAnimations", {
      configurable: true,
      value: () => [],
    });
    await i18n.changeLanguage("en");
    const first: AgentModel = {
      provider: "first",
      id: "shared",
      name: "Alpha",
      contextWindow: 10000,
      thinkingLevels: ["off", "high"],
    };
    const second: AgentModel = {
      provider: mode === "collision" ? "second" : "first",
      id: mode === "collision" ? "shared" : "other",
      name: "Beta",
      contextWindow: 40000,
      thinkingLevels: ["off", "high"],
    };
    const id = mode === "cloud" ? "bot:test:thread" : "thread";
    let session: SessionResponse = {
      id,
      model: first,
      contextTokens: 2000,
      snapshot: {
        configuration: {
          model: { provider: first.provider, modelId: first.id },
          thinkingLevel: "off",
        },
        transcript: [],
        operation: null,
        lastResult: null,
        faulted: false,
      },
    };
    let listener: ((event: AgentEvent) => void) | undefined;
    const configure = vi.fn(
      async (_id: string, provider: string, modelId: string, thinkingLevel: ThinkingLevel) => {
        const model = [first, second].find(
          (value) => value.provider === provider && value.id === modelId,
        );
        if (!model) throw new Error("Unknown model");
        session = {
          ...session,
          model,
          snapshot: {
            ...session.snapshot,
            configuration: { model: { provider, modelId }, thinkingLevel },
          },
        };
        return session;
      },
    );
    const bridge: AgentBridge = {
      openThread: async () => session,
      configureThread: configure,
      configureSandbox: async () => session,
      submit: async () => ({ operationId: "operation", kind: "run", startedAt: 0 }),
      stop: async () => {},
      subscribe: (_id, callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    };
    vi.stubGlobal("eta", bridge);
    const models = mode === "session-only" ? [second] : [first, second];
    const library: DesktopLibrary = {
      projects: [],
      workspaces: [],
      threads: [],
      credentials: [],
      providers: [],
      models:
        mode === "cloud"
          ? [first, { ...second, name: "Local decoy", contextWindow: 1000 }]
          : models,
      settings: {
        defaultProvider: first.provider,
        defaultModel: first.id,
        defaultThinkingLevel: "off",
      },
      ...(mode === "cloud"
        ? {
            bot: {
              status: "connected",
              url: "https://bot",
              library: {
                projects: [],
                workspaces: [],
                threads: [],
                models,
                settings: {
                  defaultProvider: first.provider,
                  defaultModel: first.id,
                  defaultThinkingLevel: "off",
                },
              },
            },
          }
        : {}),
    };
    const selected = vi.fn();
    const desktop = {
      library,
      error: null,
      busy: false,
      mainModel: undefined,
      selectMainModel: selected,
      refresh: async () => library,
      reload: () => {},
      act: async (work: () => Promise<void>) => {
        await work();
      },
      updateSettings: async () => {},
      clearError: () => {},
    } satisfies DesktopLibraryController;
    const tabs = new DesktopTabs();
    tabs.openThread(id, "workspace");
    const activity = new ThreadActivity(bridge);
    const recents = new ThreadRecents({ getItem: () => null, setItem: () => {} });
    let view: ReturnType<typeof useDesktopController> | undefined;
    function Host() {
      const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
      const tab = tabs.activeTab;
      if (tab.kind !== "conversation") throw new Error("Expected conversation");
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
      return createElement(ActionToolbar, {
        ...view.composer,
        canSubmit: false,
        onSubmit: () => {},
      });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Host)));
      expect(container.textContent).toContain("Alpha");
      const target =
        mode === "same" || mode === "session-only"
          ? first
          : mode === "unknown"
            ? { ...second, id: "unlisted" }
            : second;
      await act(async () => {
        listener?.({
          type: "snapshot",
          value: {
            contextTokens: 2000,
            snapshot: {
              ...session.snapshot,
              configuration: {
                model: { provider: target.provider, modelId: target.id },
                thinkingLevel: "high",
              },
            },
          },
        });
      });
      if (mode === "unknown") {
        expect(view?.composer.model).toBeUndefined();
        expect(view?.composer.contextWindow).toBeUndefined();
        expect(container.textContent).not.toContain("Alpha");
        desktop.library = {
          ...library,
          models: [...models, { ...target, name: "Arrived metadata" }],
        };
        await act(async () => root.render(createElement(Host)));
        expect(container.textContent).toContain("Arrived metadata");
        expect(view?.composer.contextWindow).toBe(target.contextWindow);
      } else {
        expect(container.textContent).toContain(target.name);
        expect(view?.composer.contextWindow).toBe(target.contextWindow);
        const percent = Math.round((2000 / target.contextWindow!) * 100);
        expect(
          [...container.querySelectorAll("button")].some((item) =>
            item.getAttribute("aria-label")?.includes(percent + "%"),
          ),
        ).toBe(true);
        expect(selected).toHaveBeenLastCalledWith({
          provider: target.provider,
          modelId: target.id,
        });
      }
      expect(configure).not.toHaveBeenCalled();
      // Select through the actual popup after the live update; the stored thread remains usable.
      await act(async () => {
        button(
          '[aria-label="' + i18n.t("chat:modelPicker.chooseAModelAndThinkingLevel") + '"]',
        ).click();
      });
      await act(async () => {
        button('[aria-label="' + i18n.t("chat:modelPicker.allModels") + '"]').click();
      });
      await act(async () => {
        button('[aria-pressed][title="' + second.provider + "/" + second.id + '"]').click();
      });
      expect(configure).toHaveBeenCalledWith(id, second.provider, second.id, "high");
      expect(container.textContent).toContain("Beta");
    } finally {
      await act(async () => root.unmount());
      activity.dispose();
      document.body.replaceChildren();
      delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
      vi.unstubAllGlobals();
      await i18n.changeLanguage("zh-CN");
    }
  },
);
