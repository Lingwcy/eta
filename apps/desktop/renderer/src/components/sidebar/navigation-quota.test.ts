// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { ConversationTab } from "@/agent/desktop-tabs";
import type { DesktopBridge, DesktopLibrary } from "../../../../src/bridge.ts";
import type { SubscriptionQuota } from "@eta/core/shared/subscription-quota";
import { i18n } from "@/i18n";
import { NavigationRail } from "./navigation-rail";

const codex = "openai-codex";
const copilot = "github-copilot";
const first = { provider: codex, modelId: "one", tabId: "chat-a", cloud: false };
const second = { provider: copilot, modelId: "two", tabId: "chat-b", cloud: false };
const catalog: DesktopLibrary = {
  projects: [],
  workspaces: [],
  threads: [],
  models: [],
  providers: [],
  settings: { defaultThinkingLevel: "off" },
  credentials: [codex, copilot].map((providerId) => ({ providerId, type: "oauth" })),
  quotaConnections: [codex, copilot].map((providerId) => ({
    providerId,
    connectionId: providerId + "-a",
  })),
};
function reading(providerId: string, connectionId: string, usedPercent = 25): SubscriptionQuota {
  return {
    providerId,
    connectionId,
    status: "ready",
    readAt: Date.now(),
    windows: [{ id: "primary", name: "primary", usedPercent }],
  };
}
async function fixture(
  query = vi.fn<DesktopBridge["subscriptionQuota"]>(async (provider, connection) =>
    reading(provider, connection),
  ),
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eta", {
    subscriptionQuota: query,
    subscribeUpdate: () => () => {},
    updateState: async () => ({ status: "idle" }),
  });
  await i18n.changeLanguage("en");
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  async function render(
    model?: Parameters<typeof NavigationRail>[0]["model"],
    library = catalog,
    settingsActive = false,
    conversationOverride: Partial<ConversationTab> = {},
  ) {
    await act(async () =>
      root.render(
        createElement(NavigationRail, {
          model,
          conversation: model
            ? {
                kind: "conversation",
                id: model.tabId,
                draft: "",
                workspaceId: null,
                environment: model.cloud ? "cloud" : "local",
                threadId: model.threadId,
                ...conversationOverride,
              }
            : undefined,
          library,
          settingsActive,
          onHome: () => {},
          onSettings: () => {},
        }),
      ),
    );
  }
  function button() {
    const button = element.querySelector<HTMLButtonElement>(
      'button[aria-label="Subscription usage"]',
    );
    expect(button).not.toBeNull();
    return button!;
  }
  async function focus() {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      button().focus();
    });
  }
  return {
    query,
    element,
    render,
    button,
    focus,
    eta: () => element.querySelector('[aria-label="Eta"]'),
    async close() {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("navigation replaces only eligible local account icons and restores Eta for no model, API keys, cloud and logout", async () => {
  const f = await fixture();
  try {
    await f.render();
    expect(f.eta()).not.toBeNull();
    await f.render(first, { ...catalog, credentials: [{ providerId: codex, type: "api_key" }] });
    await f.render({ ...first, cloud: true });
    await f.render({ ...first, provider: "unsupported" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.eta()).not.toBeNull();
    await f.render(first);
    expect(f.eta()).toBeNull();
    expect(f.button().querySelector("svg")).not.toBeNull();
    await f.focus();
    expect(document.body.textContent).toContain("75% remaining");
    await f.render(first, { ...catalog, quotaConnections: [] });
    expect(f.eta()).not.toBeNull();
    expect(document.body.textContent).not.toContain("75% remaining");
    // Settings owns a separate rail, without a current conversation model.
    await f.render(undefined, catalog, true);
    expect(f.eta()).not.toBeNull();
    expect(f.query).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test("stale tab, thread and environment selections never admit quota reads", async () => {
  const f = await fixture();
  try {
    await f.render(first, catalog, false, { id: "another-tab" });
    expect(f.eta()).not.toBeNull();
    await f.render(first, catalog, false, { threadId: "loading-thread" });
    expect(f.eta()).not.toBeNull();
    await f.render(first, catalog, false, { environment: "cloud" });
    expect(f.eta()).not.toBeNull();
    expect(f.query).not.toHaveBeenCalled();
    await f.render({ ...first, threadId: "loaded-thread" });
    expect(f.query).toHaveBeenLastCalledWith(codex, codex + "-a", false);
  } finally {
    await f.close();
  }
});

test("chat, model and account switches reload their own allowance and discard held old results", async () => {
  const held = Promise.withResolvers<SubscriptionQuota | null>();
  const query = vi.fn((provider: string, connection: string) =>
    provider === codex && connection === codex + "-a"
      ? held.promise
      : Promise.resolve(reading(provider, connection, 10)),
  );
  const f = await fixture(query);
  try {
    await f.render(first);
    await f.render(second);
    expect(query).toHaveBeenLastCalledWith(copilot, copilot + "-a", false);
    await f.focus();
    expect(document.body.textContent).toContain("90% remaining");
    await act(async () => held.resolve(reading(codex, codex + "-a", 95)));
    expect(document.body.textContent).not.toContain("5% remaining");
    expect(document.body.textContent).toContain("90% remaining");
    await f.render({ ...second, tabId: "chat-c" });
    expect(query).toHaveBeenCalledTimes(3);
    await f.render({ ...second, tabId: "chat-c", modelId: "another-model" });
    expect(query).toHaveBeenCalledTimes(4);
    await f.render(second, {
      ...catalog,
      quotaConnections: [{ providerId: copilot, connectionId: "replacement" }],
    });
    expect(query).toHaveBeenLastCalledWith(copilot, "replacement", false);
  } finally {
    held.resolve(null);
    await f.close();
  }
});

test("an unsupported or identity-mismatched quota response falls back to Eta", async () => {
  const query = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(reading(codex, "wrong-account"));
  const f = await fixture(query);
  try {
    await f.render(first);
    expect(f.eta()).not.toBeNull();
    await f.render({ ...first, tabId: "next" });
    expect(f.eta()).not.toBeNull();
    expect(f.element.querySelector('button[aria-label="Subscription usage"]')).toBeNull();
  } finally {
    await f.close();
  }
});

test("automatic updates wait a minute after completion, pause while hidden, resume on focus and stop on logout", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const held = Promise.withResolvers<SubscriptionQuota | null>();
  let cached: SubscriptionQuota | undefined;
  const query = vi.fn((_provider: string, _connection: string, _refresh?: boolean) => {
    if (!cached) return held.promise;
    // Model the real service's TTL starting at response completion, not request admission.
    if (Date.now() - cached.readAt! >= 60_000) cached = reading(codex, codex + "-a", 50);
    return Promise.resolve(cached);
  });
  const f = await fixture(query);
  try {
    await f.render(first);
    await act(async () => vi.advanceTimersByTime(500));
    cached = reading(codex, codex + "-a", 25);
    await act(async () => held.resolve(cached!));
    await act(async () => vi.advanceTimersByTime(59_500));
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(500));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith(codex, codex + "-a", false);
    await f.focus();
    expect(document.body.textContent).toContain("50% remaining");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(query).toHaveBeenCalledTimes(2);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(query).toHaveBeenCalledTimes(3);
    await f.render(first, { ...catalog, credentials: [] });
    expect(f.eta()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(query).toHaveBeenCalledTimes(3);
  } finally {
    held.resolve(null);
    await f.close();
    vi.restoreAllMocks();
  }
});

test("entering a chat or focusing near cached quota expiry does not postpone the refresh", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let cached = reading(codex, codex + "-a", 25);
  const query = vi.fn<DesktopBridge["subscriptionQuota"]>(async () => {
    if (Date.now() - cached.readAt! >= 60_000) cached = reading(codex, codex + "-a", 50);
    return cached;
  });
  // Settings already loaded this account's allowance almost a minute ago.
  vi.setSystemTime(59_000);
  const f = await fixture(query);
  try {
    await f.render(first);
    await act(async () => vi.advanceTimersByTime(500));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(query).toHaveBeenCalledTimes(2);
    // The minimum retry delay is one second, even when focus occurs near expiry.
    await act(async () => vi.advanceTimersByTime(1000));
    expect(query).toHaveBeenCalledTimes(3);
    await f.focus();
    expect(document.body.textContent).toContain("50% remaining");
  } finally {
    await f.close();
  }
});

test("refresh failure retains the last allowance and retry cooldown keeps the tooltip accessible", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const blocked: SubscriptionQuota = {
    ...reading(codex, codex + "-a"),
    status: "error",
    error: "rate-limit",
    stale: true,
    retryAt: 90_000,
  };
  const query = vi
    .fn()
    .mockResolvedValueOnce(blocked)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(reading(codex, codex + "-a", 30));
  const f = await fixture(query);
  try {
    await f.render(first);
    await f.focus();
    expect(document.body.textContent).toContain("75% remaining");
    expect(f.button().disabled).toBe(false);
    await act(async () => f.button().click());
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(60_000));
    await act(async () => f.button().blur());
    await f.focus();
    expect(document.body.textContent).toContain("75% remaining");
    expect(document.body.textContent).toContain("Unable to read usage");
    await act(async () => vi.advanceTimersByTime(30_000));
    await act(async () => f.button().click());
    expect(query).toHaveBeenLastCalledWith(codex, codex + "-a", true);
    await act(async () => f.button().blur());
    await f.focus();
    expect(document.body.textContent).toContain("70% remaining");
  } finally {
    await f.close();
  }
});
