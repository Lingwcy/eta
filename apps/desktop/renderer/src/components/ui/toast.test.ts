// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ToastNotice, ToastProvider } from "./toast";

let root: Root;
beforeEach(() => {
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
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  delete (HTMLElement.prototype as Partial<HTMLElement>).getAnimations;
  vi.unstubAllGlobals();
});

async function render(message: string | undefined, active = true, onRetry?: () => void) {
  await act(async () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(ToastNotice, { message, active, onRetry }),
        ),
      ),
    ),
  );
}

test("a background error appears once when visible, can be retried and dismissed, and can recur", async () => {
  const retry = vi.fn();
  await render("网络超时", false, retry);
  expect(document.body.textContent).not.toContain("网络超时");
  await render("网络超时", true, retry);
  expect(document.querySelectorAll('[data-type="error"]').length).toBeGreaterThan(0);
  const viewport = document.querySelector('[aria-label="通知"]')!;
  expect(viewport.textContent?.match(/网络超时/g)).toHaveLength(1);
  const button = [...viewport.querySelectorAll("button")].find(
    (button) => button.textContent === "重试",
  )!;
  await act(async () => button.click());
  expect(retry).toHaveBeenCalledTimes(1);
  await render(undefined);
  await render("网络超时", true, retry);
  await act(async () =>
    viewport.querySelector<HTMLButtonElement>('[aria-label="关闭通知"]')!.click(),
  );
  await render("网络超时", true, retry);
  expect(
    viewport.querySelector("[data-ending-style]") || !viewport.textContent?.includes("网络超时"),
  ).toBeTruthy();
  await render(undefined);
  await render("网络超时", true, retry);
  expect(viewport.textContent).toContain("网络超时");
});

test("the same error reported by two visible surfaces shares one toast", async () => {
  await act(async () =>
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(ToastNotice, { message: "Bot 未连接" }),
        createElement(ToastNotice, { message: "Bot 未连接" }),
      ),
    ),
  );
  expect(
    document.querySelector('[aria-label="通知"]')!.textContent?.match(/Bot 未连接/g),
  ).toHaveLength(1);
});
