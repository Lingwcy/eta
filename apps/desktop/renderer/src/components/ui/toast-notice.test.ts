// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { localizedMessage, type Message } from "@/i18n/messages";
import { ToastNotice, ToastProvider } from "./toast";
import { i18n } from "@/i18n";

const failure = localizedMessage("settings:subagentSettings.saveFailed") as Message;
const other = localizedMessage("chat:compositeInput.cannotSendTheMessage") as Message;

let root: Root;
let setMessage: (value: Message | undefined) => void;
let setActive: (value: boolean) => void;
let previousLanguage: string;

beforeEach(async () => {
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
  previousLanguage = i18n.language;
  await i18n.changeLanguage("en");
  function Host() {
    const [message, updateMessage] = useState<Message | undefined>(failure);
    const [active, updateActive] = useState(true);
    setMessage = updateMessage;
    setActive = updateActive;
    return createElement(ToastNotice, { message, active });
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ToastProvider, null, createElement(Host))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  await i18n.changeLanguage(previousLanguage);
});

const text = () => document.body.textContent ?? "";
// Closing keeps the node during its exit transition; wait for it instead of asserting immediately.
const gone = async (value: string) => {
  await act(async () => {
    await vi.waitFor(() => expect(text()).not.toContain(value), { timeout: 2000 });
  });
};
const show = async (message: Message | undefined) => {
  await act(async () => setMessage(message));
};
const active = async (value: boolean) => {
  await act(async () => setActive(value));
};

test("a resolved condition removes its notice, and the same failure can report again later", async () => {
  const visible = i18n.t("settings:subagentSettings.saveFailed");
  expect(text()).toContain(visible);

  await show(undefined);
  await gone(visible);

  await show(failure);
  expect(text()).toContain(visible);
});

test("a hidden notice only reports once it is visible, and clears cleanly", async () => {
  const visible = i18n.t("settings:subagentSettings.saveFailed");
  // Start from a clean surface: the initial mount already reported the first failure.
  await show(undefined);
  await gone(visible);
  await active(false);
  await show(failure);
  expect(text()).not.toContain(visible);
  await active(true);
  expect(text()).toContain(visible);
  await show(undefined);
  await gone(visible);
});

test("a superseded message reports the newest failure", async () => {
  const first = i18n.t("settings:subagentSettings.saveFailed");
  const second = i18n.t("chat:compositeInput.cannotSendTheMessage");
  expect(text()).toContain(first);
  await show(other);
  expect(text()).toContain(second);
  await gone(first);
  await show(undefined);
  await gone(second);
});
