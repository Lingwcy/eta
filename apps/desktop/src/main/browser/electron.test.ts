import { EventEmitter } from "node:events";
import { expect, test, vi } from "vite-plus/test";
import type { BrowserWindow } from "electron";

const native = vi.hoisted(() => ({ views: [] as unknown[] }));
vi.mock("electron", () => ({
  WebContentsView: class {
    preferences: unknown;
    visible = false;
    bounds?: { x: number; y: number; width: number; height: number };
    webContents = new Contents();
    constructor(options: { webPreferences: unknown }) {
      this.preferences = options.webPreferences;
      native.views.push(this);
    }
    setVisible(value: boolean) {
      this.visible = value;
    }
    setBounds(value: { x: number; y: number; width: number; height: number }) {
      this.bounds = value;
    }
  },
}));

class Contents extends EventEmitter {
  destroyed = false;
  url = "";
  openWindow?: (details: { url: string }) => { action: string };
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack() {},
    goForward() {},
  };
  isDestroyed() {
    return this.destroyed;
  }
  loadURL = async (url: string) => {
    this.url = url;
    this.emit("did-start-loading");
    this.emit("did-navigate", {}, url);
    this.emit("page-title-updated", {}, "Loaded page");
    this.emit("did-stop-loading");
  };
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
    this.openWindow = handler;
  }
  reload() {}
  stop() {}
  capturePage = async () => ({
    isEmpty: () => false,
    resize: () => ({ toDataURL: () => "data:image/png;base64,cHJldmlldw==" }),
  });
  close() {
    this.destroyed = true;
  }
}

import { createWindowBrowser, decodeBrowserCommand } from "./electron.ts";

function setup() {
  const children = new Set<unknown>();
  const send = vi.fn();
  const focus = vi.fn();
  const host = {
    webContents: { isDestroyed: () => false, send, focus },
    contentView: {
      addChildView: (view: unknown) => children.add(view),
      removeChildView: (view: unknown) => children.delete(view),
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    isDestroyed: () => false,
  };
  native.views.length = 0;
  const manager = createWindowBrowser(host as unknown as BrowserWindow);
  return {
    manager,
    children,
    send,
    focus,
    guest: () =>
      [...children][0] as {
        webContents: Contents;
        visible: boolean;
        preferences: Record<string, unknown>;
        bounds: { x: number; y: number; width: number; height: number };
      },
  };
}

test("a guest loads outside Eta's renderer, is clamped inside its window and is released on close", async () => {
  const { manager, children, guest } = setup();
  await manager.command({ type: "create", id: "web", url: "https://example.com/" });
  const page = guest();
  expect(page.webContents.url).toBe("https://example.com/");
  expect(page.preferences).toMatchObject({
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
  });
  expect(page.preferences).not.toHaveProperty("preload");
  await manager.command({
    type: "show",
    id: "web",
    bounds: { x: -20, y: 110, width: 5000, height: 5000 },
  });
  expect(page.bounds).toEqual({ x: 0, y: 110, width: 1000, height: 590 });
  expect(page.visible).toBe(true);
  await manager.command({ type: "close", id: "web" });
  expect(page.webContents.destroyed).toBe(true);
  expect(children.size).toBe(0);
});

test("web popups become tabs, unsupported navigation is blocked and guest shortcuts return to Eta", async () => {
  const { manager, guest, send, focus } = setup();
  await manager.command({ type: "create", id: "web", url: "https://example.com/" });
  const contents = guest().webContents;
  expect(contents.openWindow?.({ url: "https://example.org/" })).toEqual({ action: "deny" });
  expect(send).toHaveBeenCalledWith("browser:event", { type: "open", url: "https://example.org/" });
  const before = send.mock.calls.length;
  contents.openWindow?.({ url: "file:///private" });
  expect(send.mock.calls.length).toBe(before);
  const preventDefault = vi.fn();
  contents.emit("will-navigate", { preventDefault }, "javascript:alert(1)");
  expect(preventDefault).toHaveBeenCalledOnce();
  contents.emit(
    "before-input-event",
    { preventDefault },
    { type: "keyDown", key: "w", meta: true },
  );
  expect(focus).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith("browser:event", { type: "shortcut", action: "close-tab" });
  manager.dispose();
});

test("malformed native commands are rejected before page resources can be acquired", () => {
  for (const command of [
    null,
    { type: "create", id: "web", url: 12 },
    { type: "show", id: "web", bounds: { x: 0, y: 0, width: -1, height: 20 } },
    { type: "close", id: "web", extra: true },
  ]) {
    expect(() => decodeBrowserCommand(command)).toThrow("参数无效");
  }
  expect(decodeBrowserCommand({ type: "navigate", id: "web", url: "example.com" })).toEqual({
    type: "navigate",
    id: "web",
    url: "example.com",
  });
});
