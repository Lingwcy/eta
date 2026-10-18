// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vite-plus/test";
import type { ThreadMetadata } from "@eta/core/shared/threads";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { useDesktopLibrary } from "@/agent/use-desktop-library";
import { i18n } from "@/i18n";
import { ThreadActionsProvider, ThreadContextMenu } from "./thread-actions";

function element<T extends HTMLElement>(selector: string) {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error("Missing element: " + selector);
  return found;
}
async function input(value: string) {
  const field = element<HTMLInputElement>("input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing native input setter");
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open(id: string, kind: "rename" | "delete") {
  await act(async () => {
    element<HTMLButtonElement>("#" + id).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2, clientX: 100, clientY: 100 }),
    );
  });
  const label = i18n.t(
    kind === "rename" ? "chat:threadActions.rename" : "chat:threadActions.deletePermanently",
  );
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!item) throw new Error("Missing menu item: " + label);
  await act(async () => {
    item.click();
  });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
}
function thread(id: string): ThreadMetadata {
  return {
    id,
    workspaceId: "workspace",
    projectId: null,
    title: id,
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
const cases = (["rename", "delete"] as const).flatMap((kind) => [
  { kind, replacement: "b", fail: false },
  { kind, replacement: undefined, fail: false },
  { kind, replacement: "b", fail: true },
  { kind, replacement: undefined, fail: true },
  ...(kind === "rename" ? [{ kind, replacement: "a", fail: false }] : []),
]);

test.each(cases)(
  "thread edit ownership: $kind replacement=$replacement fail=$fail",
  async ({ kind, replacement, fail }) => {
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
    const gate = Promise.withResolvers<void>();
    let pending: Promise<void> | undefined;
    let library: DesktopLibrary = {
      projects: [],
      workspaces: [],
      threads: [thread("a"), thread("b")],
      models: [],
      providers: [],
      credentials: [],
      settings: { defaultThinkingLevel: "off", locale: "en" },
    };
    let first = true;
    const mutate = async (id: string, title?: string) => {
      if (first) {
        first = false;
        await gate.promise;
        if (fail) throw new Error("Test save failed");
      }
      library = {
        ...library,
        threads:
          title === undefined
            ? library.threads.filter((thread) => thread.id !== id)
            : library.threads.map((thread) => (thread.id === id ? { ...thread, title } : thread)),
      };
    };
    const rename = vi.fn((id: string, title: string) => {
      const task = mutate(id, title);
      pending = task;
      return task;
    });
    const remove = vi.fn((id: string) => {
      const task = mutate(id);
      pending = task;
      return task;
    });
    const read = vi.fn(async () => library);
    vi.stubGlobal("eta", {
      library: read,
      subscribeLibrary: () => () => {},
      renameThread: rename,
      deleteThread: remove,
    });
    const overlay = vi.fn();
    function Host() {
      const desktop = useDesktopLibrary();
      return createElement(ThreadActionsProvider, {
        desktop,
        onOverlay: overlay,
        children: ["a", "b"].map((id) =>
          createElement(ThreadContextMenu, {
            id,
            key: id,
            children: createElement("button", { id }, id),
          }),
        ),
      });
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(Host)));
      await open("a", kind);
      if (kind === "rename") await input("Saved A");
      await act(async () => {
        element<HTMLButtonElement>('button[type="submit"]').click();
      });
      expect(kind === "rename" ? rename : remove).toHaveBeenCalledOnce();
      expect(element<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
      if (replacement) {
        await act(async () => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        });
        expect(document.querySelector("form")).toBeNull();
        await open(replacement, "rename");
        await input("Draft " + replacement);
      }
      await act(async () => {
        gate.resolve();
        await pending?.catch(() => {});
      });
      if (!fail) {
        expect(read).toHaveBeenCalledTimes(2);
        if (kind === "delete")
          expect(library.threads.some((thread) => thread.id === "a")).toBe(false);
        else expect(library.threads.find((thread) => thread.id === "a")?.title).toBe("Saved A");
      }
      if (replacement) {
        expect(element<HTMLInputElement>("input").value).toBe("Draft " + replacement);
        expect(document.querySelector('[role="alert"]')).toBeNull();
        await act(async () => {
          element<HTMLButtonElement>('button[type="submit"]').click();
          await pending;
        });
        expect(rename).toHaveBeenLastCalledWith(replacement, "Draft " + replacement);
        expect(library.threads.find((thread) => thread.id === replacement)?.title).toBe(
          "Draft " + replacement,
        );
        expect(document.querySelector("form")).toBeNull();
      } else if (fail) {
        expect(document.querySelector("form")).not.toBeNull();
        expect(document.body.textContent).toContain("Test save failed");
        await act(async () => {
          element<HTMLButtonElement>('button[type="submit"]').click();
          await pending;
        });
        expect(document.querySelector("form")).toBeNull();
      } else {
        expect(document.querySelector("form")).toBeNull();
      }
      if (!fail) expect(read.mock.calls.length).toBeGreaterThan(1);
    } finally {
      await act(async () => {
        gate.resolve();
        await pending?.catch(() => {});
        root.unmount();
      });
      document.body.replaceChildren();
      delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
      vi.unstubAllGlobals();
      await i18n.changeLanguage("zh-CN");
    }
  },
);
