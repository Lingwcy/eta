// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { OperationAdmission, SessionResponse } from "@eta/core/agent/protocol";
import type { AgentEvent, DesktopBridge, DesktopLibrary } from "../../../../src/bridge.ts";
import { useDesktopLibrary } from "@/agent/use-desktop-library";
import { useDesktopTabs } from "@/agent/use-desktop-tabs";
import { useSchedules } from "@/agent/use-schedules";
import { ToastProvider } from "@/components/ui/toast";
import { DesktopSidebar } from "@/components/desktop-sidebar";
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
  const listeners = new Set<(event: AgentEvent) => void>();
  const publish = () => {
    for (const listener of listeners)
      listener({ type: "snapshot", value: { snapshot: session.snapshot, contextTokens: 0 } });
  };
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
    subscribe: (_id: string, listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configureThread: vi.fn(async (_id: string, provider: string, modelId: string) => {
      session.model = library.models.find(
        (model) => model.provider === provider && model.id === modelId,
      )!;
      session.snapshot = {
        ...session.snapshot,
        configuration: { model: { provider, modelId }, thinkingLevel: "off" },
        faulted: false,
        blockedReason: undefined,
      };
      publish();
      return session;
    }),
    scheduleSnapshot: async () => ({ snapshots: [] }),
    subscribeSchedules: () => () => {},
    stop: vi.fn(async () => {
      session.snapshot = { ...session.snapshot, recoveryRequired: false };
      publish();
    }),
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
    session,
    library,
    publish,
    openExisting: () => currentNavigation!.tabs.openThread(session.id, "workspace"),
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

test.each(["quota", "faulted", "blocked", "recovery"] as const)(
  "an existing %s thread keeps recovery controls usable without bypassing execution blockers",
  async (state) => {
    const { bridge, admitted, session, library, openExisting } = await setup();
    const quota = "The ChatGPT user has reached their Subscription Sharing usage limit.";
    session.snapshot = {
      ...session.snapshot,
      operation: null,
      faulted: state === "faulted",
      blockedReason:
        state === "faulted"
          ? "Execution cleanup failed"
          : state === "blocked"
            ? "Model unavailable"
            : undefined,
      recoveryRequired: state === "recovery",
      lastResult: {
        operationId: "failed-turn",
        kind: "run",
        status: "failed",
        startedAt: 1,
        endedAt: 2,
        fromTipId: null,
        tipId: null,
        error: { message: quota },
      },
    };
    library.models = [...library.models, { ...session.model, id: "two", name: "Recovery model" }];
    await act(async () => openExisting());
    const picker = () =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="' + i18n.t("chat:modelPicker.chooseAModelAndThinkingLevel") + '"]',
      )!;
    expect(input().disabled).toBe(false);
    expect(picker().disabled).toBe(false);
    await type("Try after recovery");
    if (state !== "quota") {
      await send();
      expect(bridge.submit).not.toHaveBeenCalled();
    }
    // Use the actual compound popup, not controller callback assertions alone.
    await act(async () => picker().click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="' + i18n.t("chat:modelPicker.allModels") + '"]',
        )!
        .click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-pressed][title="test/two"]')!.click(),
    );
    expect(bridge.configureThread).toHaveBeenCalledWith(session.id, "test", "two", "off");
    expect(picker().textContent).toContain("Recovery model");
    expect(input().value).toBe("Try after recovery");
    if (state === "recovery") {
      // Configuration does not implicitly resume interrupted work.
      await send();
      expect(bridge.submit).not.toHaveBeenCalled();
      await act(async () => {
        const stop = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === i18n.t("chat:recoveryNotice.stopTask"),
        );
        expect(stop).toBeDefined();
        stop!.click();
      });
      expect(bridge.stop).toHaveBeenCalledWith(session.id);
    }
    try {
      await send();
      expect(bridge.submit).toHaveBeenCalledOnce();
      expect(bridge.submit.mock.calls[0]?.[1]).toBe("Try after recovery");
      await act(async () =>
        admitted[0]!.resolve({
          operationId: "retried",
          kind: "run",
          startedAt: 3,
        }),
      );
      expect(input().value).toBe("");
    } finally {
      await act(async () => {
        for (const gate of admitted)
          gate.resolve({ operationId: "cleanup", kind: "run", startedAt: 1 });
      });
    }
  },
);

test("switching model and thinking level keeps sidebar entries and toolbar controls enabled and queues rapid updates", async () => {
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
  const firstModel = {
    provider: "provider-b",
    id: "alpha",
    name: "Model Alpha",
    contextWindow: 64000,
    thinkingLevels: ["off", "low", "high"] as const,
  };
  const secondModel = {
    provider: "provider-b",
    id: "beta",
    name: "Model Beta",
    contextWindow: 64000,
    thinkingLevels: ["off", "low", "high"] as const,
  };
  const session: SessionResponse = {
    id: "created-thread",
    model: { ...firstModel, thinkingLevels: [...firstModel.thinkingLevels] },
    contextTokens: 0,
    snapshot: {
      configuration: { model: { provider: "provider-b", modelId: "alpha" }, thinkingLevel: "low" },
      transcript: [],
      lastResult: null,
      faulted: false,
      operation: null,
    },
  };
  let library: DesktopLibrary = {
    projects: [
      { id: "project", environmentId: "local", name: "Eta", rootPath: "/test", createdAt: 0 },
    ],
    workspaces: [
      { id: "workspace", projectId: "project", cwd: "/test", kind: "project-root", createdAt: 0 },
    ],
    providers: [{ id: "provider-b", name: "Provider B", methods: ["api_key"] }],
    credentials: [],
    models: [
      { ...firstModel, thinkingLevels: [...firstModel.thinkingLevels] },
      { ...secondModel, thinkingLevels: [...secondModel.thinkingLevels] },
    ],
    settings: {
      defaultProvider: "provider-b",
      defaultModel: "alpha",
      defaultThinkingLevel: "low",
    },
    threads: [
      {
        id: session.id,
        projectId: "project",
        workspaceId: "workspace",
        title: "Saved thread",
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
  const pendingSettings = Promise.withResolvers<void>();
  const pendingConfigures = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let configureCalls = 0;
  const listeners = new Set<(event: AgentEvent) => void>();
  const bridge = {
    library: async () => library,
    subscribeLibrary: () => () => {},
    openThread: async () => session,
    subscribe: (_id: string, listener: (event: AgentEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateSettings: vi.fn(async (patch: Partial<DesktopLibrary["settings"]>) => {
      await pendingSettings.promise;
      library = { ...library, settings: { ...library.settings, ...patch } };
      return library.settings;
    }),
    configureThread: vi.fn(
      async (
        _id: string,
        provider: string,
        modelId: string,
        thinkingLevel: "off" | "low" | "high",
      ) => {
        const gate = pendingConfigures[configureCalls++];
        if (gate) await gate.promise;
        session.model = library.models.find(
          (model) => model.provider === provider && model.id === modelId,
        )!;
        session.snapshot = {
          ...session.snapshot,
          configuration: { model: { provider, modelId }, thinkingLevel },
        };
        for (const listener of listeners)
          listener({ type: "snapshot", value: { snapshot: session.snapshot, contextTokens: 0 } });
        return session;
      },
    ),
    scheduleSnapshot: async () => ({ snapshots: [] }),
    subscribeSchedules: () => () => {},
    updateState: async () => ({ status: "idle" }),
    subscribeUpdate: () => () => {},
  };
  vi.stubGlobal("eta", bridge);
  let desktopRef: ReturnType<typeof useDesktopLibrary> | undefined;
  let navigationRef: ReturnType<typeof useDesktopTabs> | undefined;
  function Harness() {
    const desktop = useDesktopLibrary();
    const navigation = useDesktopTabs(desktop.library);
    desktopRef = desktop;
    navigationRef = navigation;
    const schedules = useSchedules();
    const tab = navigation.tabs.activeTab;
    if (tab.kind !== "conversation") throw Error("Expected a conversation");
    return createElement(
      ToastProvider,
      null,
      createElement(DesktopSidebar, {
        model: desktop.mainModel,
        conversation: tab,
        scheduleView: false,
        onScheduleView: () => {},
        schedules,
        onScheduleSaved: () => {},
        library: desktop.library,
        runningThreadIds: navigation.runningThreadIds,
        visits: navigation.visits,
        workspaceId: tab.workspaceId,
        threadId: tab.threadId ?? null,
        busy: desktop.busy,
        collapsed: false,
        onExpand: () => {},
        onSelect: (id) => navigation.tabs.openThread(id, "workspace"),
        onNew: () => navigation.tabs.newConversation(),
        onChoose: () => {},
        onSettings: () => {},
        onSkills: () => {},
      }),
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
  try {
    await act(async () => root!.render(createElement(Harness)));
    const newChatButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes(i18n.t("navigation:projectSidebar.newChat")),
      )!;
    const projectButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.title === "/test",
      )!;
    const threadButton = () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Saved thread"),
      )!;
    const attachButton = () =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="' + i18n.t("chat:actionToolbar.addImages") + '"]',
      )!;
    const picker = () =>
      document.querySelector<HTMLButtonElement>(
        '[aria-label="' + i18n.t("chat:modelPicker.chooseAModelAndThinkingLevel") + '"]',
      )!;
    await act(async () => projectButton().click());
    await expect.poll(() => threadButton()).toBeDefined();
    // Even while another desktop.act() makes desktop.busy=true, sidebar navigation entries stay enabled.
    const heldAction = Promise.withResolvers<void>();
    let actionPromise: Promise<void> | undefined;
    await act(async () => {
      actionPromise = desktopRef!.act(() => heldAction.promise);
    });
    expect(desktopRef!.busy).toBe(true);
    expect(newChatButton().disabled).toBe(false);
    expect(threadButton().disabled).toBe(false);
    await act(async () => {
      heldAction.resolve();
      await actionPromise;
    });

    // 1. Unsent draft: switching model holds updateSettings without toggling busy or disabling controls.
    await act(async () => picker().click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="' + i18n.t("chat:modelPicker.allModels") + '"]',
        )!
        .click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-pressed][title="provider-b/beta"]')!.click(),
    );
    expect(bridge.updateSettings).toHaveBeenCalledWith({
      defaultProvider: "provider-b",
      defaultModel: "beta",
      defaultThinkingLevel: "low",
    });
    expect(desktopRef!.busy).toBe(false);
    expect(newChatButton().disabled).toBe(false);
    expect(threadButton().disabled).toBe(false);
    expect(attachButton().disabled).toBe(false);
    expect(picker().disabled).toBe(false);
    expect(
      document.querySelector<HTMLButtonElement>('[aria-pressed][title="provider-b/beta"]')!
        .disabled,
    ).toBe(false);
    await act(async () => {
      pendingSettings.resolve();
    });
    await act(async () => picker().click());

    // 2. Existing thread: rapid thinking-level switches keep controls enabled and commit in order.
    await act(async () => navigationRef!.tabs.openThread(session.id, "workspace"));
    await expect.poll(() => picker().disabled).toBe(false);
    await expect.poll(() => picker().textContent).toContain("Model Alpha");
    await act(async () => picker().click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[title="' + i18n.t("chat:thinkingLevelControl.adjustThinkingLevel") + '"]',
        )!
        .click(),
    );
    await expect
      .poll(() => document.querySelector<HTMLInputElement>('input[type="range"]'))
      .not.toBeNull();
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!;
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(bridge.configureThread).toHaveBeenCalledTimes(1);
    expect(bridge.configureThread).toHaveBeenLastCalledWith(
      session.id,
      "provider-b",
      "alpha",
      "high",
    );
    expect(desktopRef!.busy).toBe(false);
    expect(newChatButton().disabled).toBe(false);
    expect(threadButton().disabled).toBe(false);
    expect(attachButton().disabled).toBe(false);
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    // Second rapid change queues cleanly behind the first without dropping or disabling controls.
    expect(bridge.configureThread).toHaveBeenCalledTimes(1);
    expect(desktopRef!.busy).toBe(false);
    await act(async () => {
      pendingConfigures[0]!.resolve();
    });
    await expect.poll(() => bridge.configureThread.mock.calls.length).toBe(2);
    expect(bridge.configureThread).toHaveBeenLastCalledWith(
      session.id,
      "provider-b",
      "alpha",
      "off",
    );
    await act(async () => {
      pendingConfigures[1]!.resolve();
    });
  } finally {
    pendingSettings.resolve();
    for (const gate of pendingConfigures) gate.resolve();
  }
});
