// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { DesktopLibrary } from "../../../../../src/bridge.ts";
import type { SubscriptionQuota } from "@eta/core/shared/subscription-quota";
import { i18n } from "@/i18n";
import { ProviderList } from "./provider-list";

const provider = { id: "openai-codex", name: "Codex", methods: ["oauth" as const] };
const other = { id: "other", name: "Other", methods: ["oauth" as const] };
const now = 1_735_689_600_000;
function reading(connectionId: string, usedPercent: number): SubscriptionQuota {
  return {
    providerId: provider.id,
    connectionId,
    status: "ready",
    readAt: now,
    windows: [
      {
        id: "primary",
        name: "primary",
        windowMinutes: 300,
        usedPercent,
        resetsAt: now + 7_200_000,
      },
    ],
  };
}
function library(connectionId?: string): DesktopLibrary {
  return {
    providers: [provider, other],
    credentials: [{ providerId: provider.id, type: "oauth" }],
    models: [],
    quotaConnections: connectionId ? [{ providerId: provider.id, connectionId }] : [],
  } as unknown as DesktopLibrary;
}
async function fixture(query: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("eta", { subscriptionQuota: query });
  await i18n.changeLanguage("en");
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  async function render(value: DesktopLibrary, method: "oauth" | "api_key" = "oauth") {
    await act(async () =>
      root.render(
        createElement(ProviderList, {
          providers: [provider, other],
          library: value,
          method,
          busy: false,
          onLogin: () => {},
          onRemove: () => {},
        }),
      ),
    );
  }
  function button() {
    const result = element.querySelector<HTMLButtonElement>(
      'button[aria-label="Subscription usage"]',
    );
    expect(result).not.toBeNull();
    return result!;
  }
  async function focus() {
    const target = button();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      target.focus();
    });
    return target;
  }
  return {
    element,
    render,
    button,
    focus,
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

test("only eligible connected account gets one ring next to logout, without inline quota text", async () => {
  const query = vi.fn(async () => reading("a", 28));
  const f = await fixture(query);
  try {
    await f.render(library());
    expect(query).not.toHaveBeenCalled();
    await f.render(library("a"), "api_key");
    expect(query).not.toHaveBeenCalled();
    await f.render(library("a"));
    expect(query).toHaveBeenCalledOnce();
    const button = f.button();
    expect(button.nextElementSibling?.getAttribute("aria-label")).toBe("Disconnect Codex");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(f.element.textContent).not.toContain("72% remaining");
    expect(f.element.textContent).not.toContain("5 hours");
    await f.focus();
    expect(document.body.textContent).toContain("5 hours");
    expect(document.body.textContent).toContain("72% remaining");
    await f.render({ ...library("a"), credentials: [] });
    expect(f.element.querySelector('button[aria-label="Subscription usage"]')).toBeNull();
    expect(query).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

test("a single allowance and two allowances render distinct ring segments", async () => {
  const one = reading("a", 28);
  const two = reading("b", 28);
  two.windows.push({ id: "secondary", name: "secondary", windowMinutes: 10080, usedPercent: 31 });
  const f = await fixture(
    vi.fn((_provider: string, id: string) => Promise.resolve(id === "a" ? one : two)),
  );
  try {
    await f.render(library("a"));
    const dash = (circle: Element) =>
      Number(circle.getAttribute("stroke-dasharray")?.split(/[ ,]+/)[0]);
    const single = f.button().querySelectorAll("g");
    expect(single).toHaveLength(1);
    const singleCircles = single[0]!.querySelectorAll("circle");
    expect(singleCircles).toHaveLength(2);
    expect(dash(singleCircles[1]!) / dash(singleCircles[0]!)).toBeCloseTo(0.72);
    await f.render(library("b"));
    const segments = f.button().querySelectorAll("g");
    expect(segments).toHaveLength(2);
    const first = segments[0]!.querySelectorAll("circle");
    const second = segments[1]!.querySelectorAll("circle");
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(dash(first[0]!)).toBeCloseTo(dash(second[0]!));
    expect(dash(first[0]!)).toBeLessThanOrEqual(0.5);
    expect(dash(first[1]!) / dash(first[0]!)).toBeCloseTo(0.72);
    expect(dash(second[1]!) / dash(second[0]!)).toBeCloseTo(0.69);
    expect(first[1]!.getAttribute("class")).not.toBe(second[1]!.getAttribute("class"));
  } finally {
    await f.close();
  }
});

test("the real tooltip reports both separate windows and relative reset times", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const value = reading("a", 28);
  value.windows.push({
    id: "secondary",
    name: "secondary",
    windowMinutes: 10080,
    usedPercent: 31,
    resetsAt: now + 172_800_000,
  });
  const f = await fixture(vi.fn(async () => value));
  try {
    await f.render(library("a"));
    await f.focus();
    expect(document.body.textContent).toContain("5 hours");
    expect(document.body.textContent).toContain("72% remaining");
    expect(document.body.textContent).toContain("7 days");
    expect(document.body.textContent).toContain("69% remaining");
    expect(document.body.textContent).toContain("2 hours");
    expect(document.body.textContent).toContain("2 days");
  } finally {
    await f.close();
  }
});

test("hover opens the real tooltip and a zero allowance is not drawn as full", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const f = await fixture(vi.fn(async () => reading("a", 100)));
  try {
    await f.render(library("a"));
    const button = f.button();
    expect(button.querySelectorAll("circle")).toHaveLength(1);
    await act(async () => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("mouseenter"));
      button.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 1, clientY: 1 }));
    });
    await act(async () => vi.advanceTimersByTime(1000));
    expect(document.body.textContent).toContain("0% remaining");
  } finally {
    await f.close();
  }
});

test("old-account replies cannot replace the new account or survive disconnect", async () => {
  const old = Promise.withResolvers<SubscriptionQuota | null>();
  const query = vi.fn((_provider: string, id: string) =>
    id === "a" ? old.promise : Promise.resolve(reading(id, 10)),
  );
  const f = await fixture(query);
  try {
    await f.render(library("a"));
    await f.render(library("b"));
    await f.focus();
    expect(document.body.textContent).toContain("90% remaining");
    await act(async () => old.resolve(reading("a", 95)));
    expect(document.body.textContent).toContain("90% remaining");
    expect(document.body.textContent).not.toContain("5% remaining");
    await f.render({ ...library("b"), credentials: [] });
    expect(f.element.querySelector('button[aria-label="Subscription usage"]')).toBeNull();
  } finally {
    old.resolve(null);
    await f.close();
  }
});

test("refresh keeps previous result while pending and reports failure without losing it", async () => {
  const pending = Promise.withResolvers<SubscriptionQuota | null>();
  const query = vi
    .fn()
    .mockResolvedValueOnce(reading("a", 28))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(null);
  const f = await fixture(query);
  try {
    await f.render(library("a"));
    const button = await f.focus();
    await act(async () => button.click());
    expect(query).toHaveBeenLastCalledWith(provider.id, "a", true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.reject(new Error("offline")));
    await act(async () => button.blur());
    await f.focus();
    expect(document.body.textContent).toContain("Unable to read usage");
    expect(document.body.textContent).toContain("72% remaining");
    await act(async () => button.click());
    expect(query).toHaveBeenCalledTimes(3);
    expect(f.element.querySelector('button[aria-label="Subscription usage"]')).toBeNull();
  } finally {
    await f.close();
  }
});

test("cooldown preserves tooltip access and blocks refresh until deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const blocked: SubscriptionQuota = {
    ...reading("a", 28),
    status: "error",
    stale: true,
    error: "rate-limit",
    retryAt: now + 1000,
  };
  const query = vi.fn().mockResolvedValueOnce(blocked).mockResolvedValueOnce(reading("a", 40));
  const f = await fixture(query);
  try {
    await f.render(library("a"));
    const button = await f.focus();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("72% remaining");
    await act(async () => button.click());
    expect(query).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => button.click());
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

test("tooltip localizes counts and unlimited values", async () => {
  const value = reading("a", 28);
  value.windows = [
    { id: "premium_interactions", name: "premium_interactions", remaining: 12, total: 300 },
    { id: "chat", name: "chat", unlimited: true },
  ];
  const f = await fixture(vi.fn(async () => value));
  try {
    await f.render(library("a"));
    await f.focus();
    await act(async () => i18n.changeLanguage("zh-CN"));
    expect(document.body.textContent).toContain("高级请求");
    expect(document.body.textContent).toContain("剩余 12 / 300");
    expect(document.body.textContent).toContain("聊天请求");
    expect(document.body.textContent).toContain("不限量");
  } finally {
    await f.close();
  }
});
