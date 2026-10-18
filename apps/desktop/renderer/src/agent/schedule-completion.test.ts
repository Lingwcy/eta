// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { ThreadMetadata } from "@eta/core/shared/threads";
import { useDesktopShell } from "./use-desktop-shell";
import { i18n } from "@/i18n";

function thread(id: string): ThreadMetadata {
  return {
    id,
    title: id,
    workspaceId: "workspace",
    projectId: null,
    createdAt: 0,
    sessionRef: {
      backendId: "eta",
      metadata: {
        id,
        cwd: "/test",
        path: "/test/" + id,
        createdAt: 0,
        modifiedAt: 0,
        storageVersion: 1,
      },
    },
  };
}
const cases = (["same", "different", "closed", "current", "sidebar"] as const).flatMap((mode) =>
  [false, true].map((fail) => ({ mode, fail })),
);

test.each([...cases, { mode: "late" as const, fail: false }])(
  "schedule completion ownership: $mode failure=$fail",
  async ({ mode, fail }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    sessionStorage.clear();
    const gate = Promise.withResolvers<DesktopLibrary>();
    const failure = new Error("Catalog refresh failed");
    const library: DesktopLibrary = {
      projects: [],
      workspaces: [],
      threads: [thread("a"), thread("b")],
      models: [],
      providers: [],
      credentials: [],
      settings: { defaultThinkingLevel: "off", locale: "en" },
    };
    let reads = 0;
    const read = vi.fn(async () => {
      if (++reads === 2) return gate.promise;
      return library;
    });
    vi.stubGlobal("eta", {
      library: read,
      subscribeLibrary: () => () => {},
      scheduleSnapshot: async () => ({ snapshots: [] }),
      subscribeSchedules: () => () => {},
      subscribeBrowser: () => () => {},
      subscribe: () => () => {},
      browser: async () => null,
    });
    let shell: ReturnType<typeof useDesktopShell> | undefined;
    function Host() {
      shell = useDesktopShell();
      return createElement("output", null, shell.creatingSchedule ?? "none");
    }
    const get = () => {
      if (!shell) throw new Error("Shell not mounted");
      return shell;
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let pending: Promise<unknown> | undefined;
    try {
      await act(async () => root.render(createElement(Host)));
      expect(read).toHaveBeenCalledOnce();
      if (mode !== "sidebar")
        await act(async () => {
          get().addSchedule("a");
        });
      const completed = get().scheduleSaved;
      if (mode === "late") {
        await act(async () => {
          get().finishSchedule();
        });
        await act(async () => {
          get().addSchedule("b");
        });
      }
      await act(async () => {
        pending = completed("a").catch((error: unknown) => error);
      });
      if (["same", "different", "closed"].includes(mode)) {
        await act(async () => {
          get().finishSchedule();
        });
        if (mode === "closed")
          await act(async () => {
            get().navigation.tabs.openThread("b", "workspace");
            get().setScheduleView(false);
            get().toggleSidebar();
          });
        else
          await act(async () => {
            get().addSchedule(mode === "same" ? "a" : "b");
          });
      }
      if (mode === "late") expect(read).toHaveBeenCalledOnce();
      let result: unknown;
      await act(async () => {
        if (fail) gate.reject(failure);
        else gate.resolve(library);
        result = await pending;
      });
      expect(result).toBe(fail ? failure : undefined);
      if (mode === "same" || mode === "different" || mode === "late") {
        expect(get().creatingSchedule).toBe(mode === "same" ? "a" : "b");
        expect(container.textContent).toBe(mode === "same" ? "a" : "b");
        expect(get().navigation.tabs.activeTab).toMatchObject({
          threadId: mode === "same" ? "a" : "b",
        });
      } else if (mode === "closed") {
        expect(get().creatingSchedule).toBeUndefined();
        expect({
          tab: get().navigation.tabs.activeTab,
          scheduleView: get().scheduleView,
          collapsed: get().collapsed,
        }).toMatchObject({ tab: { threadId: "b" }, scheduleView: false, collapsed: true });
      } else if (fail) {
        expect(get().creatingSchedule).toBe(mode === "current" ? "a" : undefined);
      } else {
        expect(get().creatingSchedule).toBeUndefined();
        expect(get().navigation.tabs.activeTab).toMatchObject({ threadId: "a" });
        expect(get().scheduleView).toBe(true);
      }
    } finally {
      await act(async () => {
        gate.resolve(library);
        await pending;
        root.unmount();
      });
      document.body.replaceChildren();
      localStorage.clear();
      sessionStorage.clear();
      vi.unstubAllGlobals();
      await i18n.changeLanguage("zh-CN");
    }
  },
);
