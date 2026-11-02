// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { OperationAdmission, SessionResponse } from "@eta/core/agent/protocol";
import type { DesktopBridge, DesktopLibrary } from "../../../../src/bridge.ts";
import { useDesktopLibrary } from "@/agent/use-desktop-library";
import { useDesktopTabs } from "@/agent/use-desktop-tabs";
import { useSchedules } from "@/agent/use-schedules";
import { ToastProvider } from "@/components/ui/toast";
import { i18n } from "@/i18n";
import { ConversationPanel } from "./conversation-panel";

let root: Root | undefined;
const animations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  localStorage.clear();
  vi.unstubAllGlobals();
  if (animations) Object.defineProperty(HTMLElement.prototype, "getAnimations", animations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

async function setup() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const NativeReader = FileReader;
  vi.stubGlobal(
    "FileReader",
    class extends NativeReader {
      override readAsDataURL() {
        Object.defineProperty(this, "result", { value: "data:image/png;base64,AA==" });
        this.dispatchEvent(new ProgressEvent("load"));
      }
    },
  );
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
  const session: SessionResponse = {
    id: "created-thread",
    model: {
      provider: "test",
      id: "one",
      name: "Test model",
      contextWindow: 64000,
      thinkingLevels: ["off"],
    },
    contextTokens: 0,
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [],
      lastResult: null,
      faulted: false,
      inputQueueSupported: true,
      operation: {
        id: "root",
        kind: "run",
        startedAt: 1,
        status: "running",
        fromTipId: null,
        runningTools: [],
        streamingMessage: fauxAssistantMessage("Still working", { timestamp: 1 }),
      },
    },
  };
  const library: DesktopLibrary = {
    projects: [],
    workspaces: [],
    providers: [],
    credentials: [],
    models: [session.model],
    settings: { defaultThinkingLevel: "off" },
    threads: [
      {
        id: session.id,
        workspaceId: "workspace",
        title: "Test thread",
        createdAt: 0,
        sessionRef: {
          backendId: "eta",
          metadata: {
            id: session.id,
            cwd: "/test",
            path: "/test/thread",
            createdAt: 0,
            modifiedAt: 0,
            storageVersion: 1,
          },
        },
      },
    ],
  };
  const admitted = Array.from({ length: 3 }, () => Promise.withResolvers<OperationAdmission>());
  let call = 0;
  const submit = vi.fn<DesktopBridge["submit"]>(() => admitted[call++]!.promise);
  const bridge = {
    library: async () => library,
    subscribeLibrary: () => () => {},
    createThread: vi.fn(async () => session),
    openThread: async () => session,
    submit,
    operation: async () => ({
      operationId: "root",
      kind: "run" as const,
      startedAt: 1,
      status: "running" as const,
      messages: [],
    }),
    subscribe: () => () => {},
    scheduleSnapshot: async () => ({ snapshots: [] }),
    subscribeSchedules: () => () => {},
    stop: vi.fn(async () => {}),
    prepareImage: async () => ({
      type: "image" as const,
      mimeType: "image/png",
      data: "AA==",
      name: "constraint.png",
    }),
  };
  vi.stubGlobal("eta", bridge);
  let currentNavigation: ReturnType<typeof useDesktopTabs> | undefined;
  function Harness() {
    const desktop = useDesktopLibrary();
    const navigation = useDesktopTabs(desktop.library);
    currentNavigation = navigation;
    const schedules = useSchedules();
    const tab = navigation.tabs.activeTab;
    if (tab.kind !== "conversation") throw Error("Expected a conversation");
    return createElement(
      ToastProvider,
      null,
      createElement(ConversationPanel, {
        key: tab.id,
        tab,
        desktop,
        navigation,
        schedules,
        active: true,
        version: 0,
        onPreview: () => {},
        onRoot: () => {},
      }),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Harness)));
  return {
    bridge,
    admitted,
    closeTab: () => currentNavigation!.tabs.close(currentNavigation!.state.activeId),
  };
}
function input() {
  return document.querySelector("textarea")!;
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input(),
      text,
    );
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function send(metaKey = false, click = false) {
  await act(async () => {
    if (click)
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="' + i18n.t("chat:actionToolbar.sendMessage") + '"]',
        )!
        .click();
    else
      input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey, bubbles: true, cancelable: true }),
      );
  });
}

test.each([false, true])(
  "first send clears the controlled draft after creation and admission (click=%s)",
  async (click) => {
    const { bridge, admitted } = await setup();
    try {
      await type("First request");
      await send(false, click);
      expect(bridge.createThread).toHaveBeenCalledOnce();
      expect(bridge.submit).toHaveBeenCalledOnce();
      expect(input().value).toBe("First request");
      await act(async () =>
        admitted[0]!.resolve({ operationId: "root", kind: "run", startedAt: 1 }),
      );
      expect(input().value).toBe("");
      expect(input().disabled).toBe(false);
      expect(
        document.querySelector(
          '[aria-label="' + i18n.t("chat:actionToolbar.stopGeneration") + '"]',
        ),
      ).not.toBeNull();
      for (const metaKey of [false, true]) {
        await type(metaKey ? "Later task" : "New constraint");
        await send(metaKey, click);
        expect(bridge.submit.mock.calls.at(-1)?.[4]).toBe(!click && metaKey ? "followUp" : "steer");
        await act(async () =>
          admitted[metaKey ? 2 : 1]!.resolve({
            operationId: metaKey ? "3" : "2",
            kind: "run",
            startedAt: 2,
            status: "queued",
          }),
        );
        expect(input().value).toBe("");
        expect(input().disabled).toBe(false);
      }
    } finally {
      await act(async () => {
        for (const gate of admitted)
          gate.resolve({ operationId: "cleanup", kind: "run", startedAt: 1 });
      });
    }
  },
);

test("a rejected first admission retains the original draft and attachment after thread creation", async () => {
  const { bridge, admitted } = await setup();
  try {
    await type("Keep on rejection");
    await act(async () => {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [new File(["fixture"], "constraint.png", { type: "image/png" })] },
      });
      input().dispatchEvent(paste);
    });
    expect(document.querySelector('img[alt="constraint.png"]')).not.toBeNull();
    await send();
    expect(bridge.createThread).toHaveBeenCalledOnce();
    await act(async () => admitted[0]!.reject(new Error("Admission rejected")));
    expect(input().value).toBe("Keep on rejection");
    expect(document.querySelector('img[alt="constraint.png"]')).not.toBeNull();
    expect(input().disabled).toBe(false);
  } finally {
    await act(async () => {
      for (const gate of admitted)
        gate.resolve({ operationId: "cleanup", kind: "run", startedAt: 1 });
    });
  }
});

test("a closed conversation's late admission cannot clear the replacement draft", async () => {
  const { bridge, admitted, closeTab } = await setup();
  try {
    await type("Original request");
    await send();
    expect(bridge.submit).toHaveBeenCalledOnce();
    await act(async () => closeTab());
    await type("Replacement draft");
    await act(async () => admitted[0]!.resolve({ operationId: "root", kind: "run", startedAt: 1 }));
    expect(input().value).toBe("Replacement draft");
    expect(input().disabled).toBe(false);
    expect(bridge.submit).toHaveBeenCalledOnce();
  } finally {
    await act(async () => {
      for (const gate of admitted)
        gate.resolve({ operationId: "cleanup", kind: "run", startedAt: 1 });
    });
  }
});
