// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";
import { ModelRecents, modelRecents } from "./model-recents";
import { readTabs } from "./tab-storage";
import { useDesktopTabs } from "./use-desktop-tabs";

type Area = "localStorage" | "sessionStorage";
function denyStorage(area: Area) {
  const failure = new DOMException("Storage access denied", "SecurityError");
  const originals = [...new Set<object>([window, globalThis])].map((target) => ({
    target,
    descriptor: Object.getOwnPropertyDescriptor(target, area),
  }));
  for (const { target } of originals)
    Object.defineProperty(target, area, {
      configurable: true,
      get() {
        throw failure;
      },
    });
  return {
    failure,
    restore() {
      for (const { target, descriptor } of originals)
        if (descriptor) Object.defineProperty(target, area, descriptor);
        else Reflect.deleteProperty(target, area);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(["localStorage", "sessionStorage"] as const)(
  "tabs remain editable when the %s getter rejects, then persist after recovery",
  async (area) => {
    if (area === "sessionStorage") history.replaceState(null, "", "/?thread=detached");
    const denied = denyStorage(area);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = document.createElement("div");
    const root = createRoot(container);
    let controller: ReturnType<typeof useDesktopTabs> | undefined;
    function Probe() {
      controller = useDesktopTabs(null);
      return createElement("div", null, controller.state.tabs.length);
    }
    const current = () => {
      if (!controller) throw new Error("Tabs failed to mount");
      return controller;
    };
    try {
      await act(async () => root.render(createElement(Probe)));
      await act(async () => {
        current().tabs.updateConversation(current().state.activeId, { draft: "Still editable" });
        current().recordInput("remembered-input");
      });
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });
      expect(current().tabs.activeTab).toMatchObject({ draft: "Still editable" });
      expect(current().visits.map((visit) => visit.threadId)).toEqual(["remembered-input"]);
      expect(warn).toHaveBeenCalledWith("Unable to save desktop tabs", denied.failure);
      denied.restore();
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
      });
      const restored = new DesktopTabs(undefined, readTabs(window[area]));
      expect(restored.activeTab).toMatchObject({ draft: "Still editable" });
    } finally {
      try {
        await act(async () => root.unmount());
      } finally {
        denied.restore();
      }
    }
  },
);

test("recent-model factory retains memory choices while its storage getter rejects and recovers", () => {
  const denied = denyStorage("localStorage");
  const first = { scope: "local", provider: "p", modelId: "first", thinkingLevel: "off" } as const;
  const second = { ...first, modelId: "second" };
  try {
    const recents = modelRecents();
    recents.record(first);
    recents.record(second);
    expect(recents.getSnapshot()).toEqual([second, first]);
    denied.restore();
    recents.record(first);
    expect(new ModelRecents(window.localStorage).getSnapshot()).toEqual([first, second]);
  } finally {
    denied.restore();
  }
});
