// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { SettingsSidebar } from "@/components/settings/settings-sidebar";
import { Tabs } from "@/components/ui/tabs";
import { ToastNotice, ToastProvider } from "@/components/ui/toast";
import { useDesktopLibrary } from "@/agent/use-desktop-library";
import type { DesktopBridge, DesktopLibrary } from "../../../src/bridge.ts";
import { i18n, initializeLocale } from "./index";
import { describeError, localizedMessage, renderMessage, LocalizedError } from "./messages";
import { commandReply } from "../../../src/main/ipc.ts";
import { unwrapReply } from "../../../src/command-reply.ts";
import { threadTitle } from "./thread-title";
import { scheduleRuleText, scheduleTime } from "@/components/schedules/format";

const roots: Root[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  await i18n.changeLanguage("zh-CN");
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  vi.unstubAllGlobals();
});

function fixture() {
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
  let library: DesktopLibrary = {
    projects: [],
    workspaces: [],
    threads: [],
    credentials: [],
    models: [],
    providers: [],
    settings: { defaultThinkingLevel: "off" },
  };
  const listeners = new Set<() => void>();
  let fail = false;
  const bridge = {
    library: async () => library,
    subscribeLibrary(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateSettings: vi.fn(async (patch) => {
      if (fail) throw new Error("Disk full");
      library = { ...library, settings: { ...library.settings, ...patch } };
      for (const listener of listeners) listener();
      return library.settings;
    }),
  } satisfies Pick<DesktopBridge, "library" | "subscribeLibrary" | "updateSettings">;
  vi.stubGlobal("eta", bridge);
  function Window() {
    const desktop = useDesktopLibrary();
    const [query, setQuery] = useState("");
    if (!desktop.library) return null;
    return createElement(
      ToastProvider,
      null,
      createElement(
        Tabs,
        { value: "appearance", onValueChange: () => {} },
        createElement(SettingsSidebar, { query, onQuery: setQuery, onClose: () => {} }),
        createElement("textarea", { "aria-label": "draft", defaultValue: "Keep this draft" }),
        createElement(AppearanceSettings, {
          locale: desktop.library.settings.locale,
          variant: "wave",
          active: false,
          busy: desktop.busy,
          onVariantChange: () => {},
          onLocaleChange: (locale) => {
            void desktop.updateSettings({ locale }).catch(() => {});
          },
        }),
        createElement(ToastNotice, { message: desktop.error }),
      ),
    );
  }
  return {
    Window,
    bridge,
    listeners,
    fail: () => {
      fail = true;
    },
  };
}

async function mount(Window: () => ReturnType<typeof createElement> | null) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(Window)));
  return container;
}

async function choose(container: HTMLElement, language: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="语言 / Language"]',
  )!;
  expect(trigger).not.toBeNull();
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === language,
  );
  expect(option).toBeDefined();
  await act(async () => option!.click());
}

test("first paint uses main's saved language and an unavailable bootstrap falls back to Chinese", async () => {
  await initializeLocale({
    appInfo: async () => ({ version: "test", platform: "darwin", locale: "en" }),
  });
  expect(i18n.language).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  await initializeLocale({
    appInfo: async () => {
      throw new Error("Unavailable");
    },
  });
  expect(i18n.language).toBe("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
});

test("real language picker updates existing settings and a second window without remounting drafts", async () => {
  const { Window, bridge, listeners } = fixture();
  const first = await mount(Window);
  const second = await mount(Window);
  const draft = first.querySelector("textarea")!;
  draft.value = "Unsent user content";
  expect(first.textContent).toContain("思考与响应");
  await choose(first, "English");
  expect(bridge.updateSettings).toHaveBeenLastCalledWith({ locale: "en" });
  expect(first.textContent).toContain("Thinking and responses");
  expect(second.textContent).toContain("Thinking and responses");
  expect(first.querySelector('[aria-label="Search settings categories"]')).not.toBeNull();
  expect(document.documentElement.lang).toBe("en");
  expect(first.querySelector("textarea")).toBe(draft);
  expect(draft.value).toBe("Unsent user content");
  const animation = first.querySelector<HTMLButtonElement>(
    '[aria-label="Thinking animation style"]',
  )!;
  await act(async () => animation.click());
  expect(document.body.textContent).toContain("Twinkling stars");
  await act(async () => {
    await i18n.changeLanguage("zh-CN");
  });
  expect(document.body.textContent).toContain("星光闪烁");
  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await choose(second, "简体中文");
  expect(first.textContent).toContain("思考与响应");
  expect(first.querySelector("textarea")).toBe(draft);
  expect(listeners.size).toBe(2);
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  expect(listeners.size).toBe(0);
});

test("failed saving keeps the confirmed language and the unsent draft", async () => {
  const { Window, fail } = fixture();
  const container = await mount(Window);
  fail();
  const draft = container.querySelector("textarea");
  await choose(container, "English");
  expect(container.textContent).toContain("思考与响应");
  expect(document.body.textContent).toContain("Disk full");
  expect(i18n.language).toBe("zh-CN");
  expect(container.querySelector("textarea")).toBe(draft);
});

test("errors retain localization across IPC, and summaries update without rewriting diagnostics", async () => {
  const reply = await commandReply(async () => {
    throw new LocalizedError("chat:draftThread.chooseAProjectFirst");
  });
  let message;
  try {
    unwrapReply(reply);
  } catch (error) {
    message = describeError(error);
  }
  expect(renderMessage(message)).toBe("请先选择项目");
  await i18n.changeLanguage("en");
  expect(renderMessage(message)).toBe("Choose a project first");
  const raw = Object.assign(new Error("原始诊断"), { code: "RecoveryRequired" });
  expect(renderMessage(describeError(raw))).toContain("Resume or stop it first.");
  expect(renderMessage(describeError(raw))).toContain("原始诊断");
  const pending = localizedMessage("settings:botSettings.importedCredentialsForProviders", {
    count: 1,
  });
  expect(renderMessage(pending)).toBe("Imported credentials for 1 provider");
});

test("language changes format schedules and initial placeholders while preserving user titles and rules", async () => {
  const now = new Date(2026, 11, 31, 23, 50).getTime();
  const tomorrow = new Date(2027, 0, 1, 9, 5).getTime();
  const rule = {
    type: "weekly",
    weekdays: [1, 3],
    time: "09:00",
    timeZone: "Asia/Shanghai",
  } as const;
  const saved = structuredClone(rule);
  expect(scheduleTime(tomorrow, now)).toBe("明天 09:05");
  await i18n.changeLanguage("en");
  expect(scheduleTime(tomorrow, now)).toBe("Tomorrow 09:05");
  expect(scheduleRuleText(rule)).toBe("Weekly on Mon, Wed at 09:00");
  expect(rule).toEqual(saved);
  expect(threadTitle({ title: "新会话", titleSource: "temporary" })).toBe("New chat");
  for (const titleSource of ["manual", "generated", undefined] as const) {
    expect(threadTitle({ title: "新会话", titleSource })).toBe("新会话");
  }
  expect(threadTitle({ title: "用户第一条消息", titleSource: "temporary" })).toBe("用户第一条消息");
});
