// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { CreateProjectDialog } from "./create-project-dialog";
import { DesktopCommandError } from "../../../../src/command-reply.ts";
import { i18n } from "@/i18n";

type Create = (rootPath: string, name: string, requestId: string) => Promise<void>;
let root: Root;
let setOpen: (open: boolean) => void;
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  await i18n.changeLanguage(previousLanguage);
});

async function mount(onCreate: Create, cloud = true) {
  function Host() {
    const [open, update] = useState(true);
    setOpen = update;
    return createElement(CreateProjectDialog, {
      open,
      onOpenChange: update,
      onCreate,
      cloud,
      cloudRoot: cloud ? "/srv/bots/root" : undefined,
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Host)));
}

const nameInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
async function type(name: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      nameInput(),
      name,
    );
    nameInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function createButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.type === "submit",
  )!;
}
async function submit() {
  await act(async () => createButton().click());
}

test("a retried project creation keeps one request identity until it succeeds", async () => {
  const calls: [string, string, string][] = [];
  const onCreate = vi.fn<Create>(async (rootPath, name, requestId) => {
    calls.push([rootPath, name, requestId]);
    if (calls.length === 1)
      throw new DesktopCommandError({
        code: "BotRequestFailed",
        message: "Request timed out",
        retryable: true,
      });
  });
  await mount(onCreate);
  await type("Review bot");
  await submit();
  await expect.poll(() => onCreate.mock.calls.length).toBe(1);
  expect(document.body.textContent).toContain("Request timed out");
  expect(nameInput().value).toBe("Review bot");
  expect(calls[0]![2]).toBeTruthy();

  await submit();
  await expect.poll(() => onCreate.mock.calls.length).toBe(2);
  expect(calls[1]![2]).toBe(calls[0]![2]);
  await expect.poll(() => document.querySelector('input[aria-label="Project name"]')).toBeNull();
});

test("a changed name is a new project attempt with its own identity", async () => {
  const calls: [string, string, string][] = [];
  const onCreate = vi.fn<Create>(async (rootPath, name, requestId) => {
    calls.push([rootPath, name, requestId]);
    if (calls.length === 1) throw new Error("Project directory is unavailable");
  });
  await mount(onCreate);
  await type("First name");
  await submit();
  await expect.poll(() => onCreate.mock.calls.length).toBe(1);
  await type("Second name");
  await submit();
  await expect.poll(() => onCreate.mock.calls.length).toBe(2);
  expect(calls[1]![2]).toBeTruthy();
  expect(calls[1]![2]).not.toBe(calls[0]![2]);
});
