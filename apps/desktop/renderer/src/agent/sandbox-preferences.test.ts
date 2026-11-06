// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AgentBridge, DesktopBridge, DesktopLibrary } from "../../../src/bridge.ts";
import type { SandboxMode } from "@eta/core/shared/sandbox";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CoreEnvironmentService } from "@eta/core/service/environment";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { setup } from "../../../src/main/tests/runtime-fixture.ts";
import { useDesktopLibrary } from "./use-desktop-library";
import { useDesktopController } from "./use-desktop-controller";
import { DesktopTabs } from "./desktop-tabs";
import { ThreadActivity } from "./thread-activity";
import { ThreadRecents } from "./thread-recents";
import { ActionToolbar } from "@/components/input/action-toolbar";
import { i18n } from "@/i18n";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  vi.unstubAllGlobals();
});

async function mount(cloud = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  await i18n.changeLanguage("zh-CN");
  const f = await setup();
  const remoteSettings = {
    defaultThinkingLevel: "off",
    defaultSandboxMode: "workspace-write",
  } as const;
  const library = async (): Promise<DesktopLibrary> => ({
    projects: [],
    workspaces: [f.workspace],
    threads: [],
    credentials: [],
    providers: [],
    models: [f.created.model],
    settings: await f.runtime.runPromise(f.settings.read),
    ...(cloud
      ? {
          bot: {
            status: "connected",
            url: "https://bot.test",
            library: {
              projects: [],
              workspaces: [],
              threads: [],
              models: [f.created.model],
              settings: remoteSettings,
              allowedSandboxModes: ["read-only", "workspace-write"],
            },
          },
        }
      : {}),
  });
  const bridge = {
    library,
    subscribeLibrary: (listener) => f.settings.subscribe(listener),
    updateSettings: (patch) => f.runtime.runPromise(f.settings.update(patch)),
    createThread: (workspaceId, requestId, configuration) =>
      f.runtime.runPromise(f.threads.create(workspaceId, requestId, configuration)),
    openThread: (id) => f.runtime.runPromise(f.threads.open(id)),
    configureSandbox: vi.fn((id: string, mode: SandboxMode) =>
      f.runtime.runPromise(f.threads.configureSandbox(id, mode)),
    ),
    configureThread: (id, provider, modelId, level) =>
      f.runtime.runPromise(f.threads.configure(id, provider, modelId, level)),
    operation: (id, operationId) => f.runtime.runPromise(f.threads.operation(id, operationId)),
    submit: (id, prompt) => f.runtime.runPromise(f.threads.submit(id, prompt)),
    stop: (id) => f.runtime.runPromise(f.threads.stop(id)),
    subscribe: () => () => {},
  } satisfies AgentBridge &
    Pick<DesktopBridge, "library" | "subscribeLibrary" | "updateSettings" | "createThread">;
  vi.stubGlobal("eta", bridge);
  const tabs = new DesktopTabs();
  if (cloud) tabs.updateConversation(tabs.activeTab.id, { environment: "cloud" });
  const activity = new ThreadActivity(bridge);
  cleanups.push(async () => activity.dispose());
  const recents = new ThreadRecents({ getItem: () => null, setItem: () => {} });
  let view: ReturnType<typeof useDesktopController> | undefined;
  let pending: Promise<void> | undefined;
  function Host() {
    const desktop = useDesktopLibrary();
    const actions = {
      ...desktop,
      act: (action: Parameters<typeof desktop.act>[0]) => {
        pending = desktop.act(action);
        return pending;
      },
    };
    const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
    const tab = tabs.activeTab;
    if (tab.kind !== "conversation") throw new Error("Expected a conversation");
    view = useDesktopController(
      tab,
      actions,
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
    return createElement(ActionToolbar, { ...view.composer, canSubmit: false, onSubmit: () => {} });
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
  });
  await act(async () => root.render(createElement(Host)));
  await expect
    .poll(async () => {
      await act(async () => {});
      return view?.composer.model;
    })
    .toBeDefined();
  return {
    ...f,
    bridge,
    tabs,
    settle: () => pending ?? Promise.resolve(),
    current: () => {
      if (!view) throw new Error("Not mounted");
      return view;
    },
  };
}

async function choose(mode: SandboxMode, settle: () => Promise<void>) {
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button[aria-label^=沙盒策略：]")!.click(),
  );
  const picker = document.querySelector("[aria-label=沙盒策略]")!;
  const label = i18n.t(`chat:sandbox.${mode}`);
  const option = [...picker.querySelectorAll<HTMLButtonElement>("button")].find((value) =>
    value.textContent?.startsWith(label),
  )!;
  expect(option.disabled).toBe(false);
  await act(async () => {
    option.click();
    await settle();
  });
}

test.each([undefined, "workspace-write", "read-only"] as const)(
  "the first submitted message creates a chat with preference=%s",
  async (mode) => {
    const f = await mount();
    // Native worker discovery requires file URLs, not jsdom's HTTP module URLs.
    const environment = await f.runtime.runPromise(CoreEnvironmentService);
    vi.spyOn(environment, "executionEnvironment").mockImplementation(
      (cwd) => new NodeExecutionEnv({ cwd }),
    );
    if (mode) await choose(mode, f.settle);
    f.provider.setResponses([fauxAssistantMessage("Done")]);
    await act(async () => {
      await f.current().composer.onSubmit("Check permissions");
    });
    const tab = f.tabs.activeTab;
    if (tab.kind !== "conversation" || !tab.threadId) throw new Error("Chat was not created");
    const session = await f.runtime.runPromise(f.threads.open(tab.threadId));
    expect(session.snapshot.sandbox?.mode).toBe(mode ?? "danger-full-access");
  },
);

test("manual draft choices control subsequent new chats in both directions", async () => {
  const f = await mount();
  expect(f.current().composer.sandboxMode).toBe("danger-full-access");
  for (const mode of [
    "workspace-write",
    "read-only",
    "danger-full-access",
    "workspace-write",
  ] as const) {
    await choose(mode, f.settle);
    expect(f.current().composer.sandboxDisabled).toBe(false);
    expect((await f.runtime.runPromise(f.settings.read)).defaultSandboxMode).toBe(mode);
    await act(async () => {
      f.tabs.newConversation(null);
    });
    expect(f.current().composer.sandboxMode).toBe(mode);
    const created = await f.runtime.runPromise(f.threads.create(f.workspace.id));
    expect(created.snapshot.sandbox?.mode).toBe(mode);
  }
});

test("opening an existing chat preserves its policy; only a successful manual change updates the default", async () => {
  const f = await mount();
  await f.runtime.runPromise(f.threads.configureSandbox(f.created.id, "read-only"));
  await act(async () => {
    f.tabs.openThread(f.created.id, f.workspace.id);
  });
  await expect
    .poll(async () => {
      await act(async () => {});
      return f.current().composer.sandboxMode;
    })
    .toBe("read-only");
  expect((await f.runtime.runPromise(f.settings.read)).defaultSandboxMode).toBe(
    "danger-full-access",
  );
  f.bridge.configureSandbox.mockRejectedValueOnce(new Error("Policy change rejected"));
  await choose("workspace-write", f.settle);
  expect(f.current().composer.sandboxDisabled).toBe(false);
  expect((await f.runtime.runPromise(f.settings.read)).defaultSandboxMode).toBe(
    "danger-full-access",
  );
  expect(f.current().composer.sandboxMode).toBe("read-only");
  await choose("workspace-write", f.settle);
  expect(f.current().composer.sandboxDisabled).toBe(false);
  expect((await f.runtime.runPromise(f.settings.read)).defaultSandboxMode).toBe("workspace-write");
  await act(async () => {
    f.tabs.newConversation(null);
  });
  expect(f.current().composer.sandboxMode).toBe("workspace-write");
});

test("local full-access default does not override Bot defaults or allowed modes", async () => {
  const f = await mount(true);
  expect(f.current().composer.sandboxMode).toBe("workspace-write");
  await act(async () =>
    document.querySelector<HTMLButtonElement>("button[aria-label^=沙盒策略：]")!.click(),
  );
  const options = [...document.querySelectorAll<HTMLButtonElement>("[aria-label=沙盒策略] button")];
  expect(options.find((option) => option.textContent?.startsWith("完全访问"))?.disabled).toBe(true);
  await act(async () => {
    options.find((option) => option.textContent?.startsWith("只读"))!.click();
    await f.settle();
  });
  expect(f.current().composer.sandboxDisabled).toBe(false);
  expect(f.current().composer.sandboxMode).toBe("read-only");
  expect((await f.runtime.runPromise(f.settings.read)).defaultSandboxMode).toBe(
    "danger-full-access",
  );
});
