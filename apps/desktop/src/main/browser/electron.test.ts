import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { BrowserWindow, Session, WebContents } from "electron";

const native = vi.hoisted(() => ({
  views: [] as unknown[],
  sessions: new Map<string, PermissionSession>(),
}));
class PermissionSession {
  check: Parameters<Session["setPermissionCheckHandler"]>[0] = null;
  request: Parameters<Session["setPermissionRequestHandler"]>[0] = null;
  device: Parameters<Session["setDevicePermissionHandler"]>[0] = null;
  setPermissionCheckHandler(handler: typeof this.check) {
    this.check = handler;
  }
  setPermissionRequestHandler(handler: typeof this.request) {
    this.request = handler;
  }
  setDevicePermissionHandler(handler: typeof this.device) {
    this.device = handler;
  }
}
function sessionFor(partition: string) {
  let session = native.sessions.get(partition);
  if (!session) {
    session = new PermissionSession();
    native.sessions.set(partition, session);
  }
  return session;
}
beforeEach(() => native.sessions.clear());
vi.mock("electron", () => ({
  session: { fromPartition: (partition: string) => sessionFor(partition) },
  WebContentsView: class {
    preferences: unknown;
    visible = false;
    bounds?: { x: number; y: number; width: number; height: number };
    webContents: Contents;
    constructor(options: { webPreferences: { session?: PermissionSession; partition?: string } }) {
      this.webContents = new Contents(
        options.webPreferences.session ?? sessionFor(options.webPreferences.partition ?? "default"),
      );
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
  policyAtLoad: boolean[] = [];
  constructor(readonly session: PermissionSession) {
    super();
  }
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
    this.policyAtLoad = [
      this.session.check?.(null, "media", url, { isMainFrame: true, requestingUrl: url }) ?? true,
    ];
    if (this.session.request)
      this.session.request(
        this as unknown as WebContents,
        "media",
        (allow) => this.policyAtLoad.push(allow),
        { isMainFrame: true, requestingUrl: url },
      );
    else this.policyAtLoad.push(true);
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

test.each(["back", "forward", "reload"] as const)(
  "%s recovers from a failed address load without hiding a new failure",
  async (type) => {
    const { manager, guest, send } = setup();
    try {
      await manager.command({ type: "create", id: "web", url: "example.com" });
      const contents = guest().webContents;
      contents.loadURL = async (url) => {
        contents.emit("did-fail-load", {}, -105, "DNS failure", url, true);
        throw new Error("ERR_NAME_NOT_RESOLVED");
      };
      await manager.command({ type: "navigate", id: "web", url: "missing.example.com" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send.mock.calls.at(-1)?.[1].state.error).toBeTruthy();
      const recovered = () => {
        contents.emit("did-navigate", {}, "https://example.com/recovered");
      };
      contents.navigationHistory.canGoBack = () => true;
      contents.navigationHistory.canGoForward = () => true;
      contents.navigationHistory.goBack = recovered;
      contents.navigationHistory.goForward = recovered;
      contents.reload = recovered;
      const state = await manager.command({ type, id: "web" });
      expect(state?.url).toBe("https://example.com/recovered");
      expect(state?.error).toBeUndefined();
      expect(send.mock.calls.at(-1)?.[1].state.error).toBeUndefined();
      contents.emit(
        "did-fail-load",
        {},
        -106,
        "New network failure",
        "https://example.com/recovered",
        true,
      );
      expect(send.mock.calls.at(-1)?.[1].state.error).toBeTruthy();
    } finally {
      manager.dispose();
    }
  },
);

test.each([
  "media",
  "notifications",
  "geolocation",
  "clipboard-read",
  "fileSystem",
  "display-capture",
  "hid",
  "serial",
  "usb",
  "unknown",
] as const)(
  "guest permission %s is denied for checks and requests in main and child frames",
  async (permission) => {
    const { manager, guest } = setup();
    try {
      await manager.command({ type: "create", id: "web", url: "https://example.com/" });
      const contents = guest().webContents;
      for (const isMainFrame of [true, false]) {
        for (const origin of ["https://example.com", "http://localhost"]) {
          const details = { isMainFrame, requestingUrl: origin };
          expect(contents.session.check?.(null, permission, origin, details) ?? true).toBe(false);
          expect(
            contents.session.check?.(
              contents as unknown as WebContents,
              permission,
              origin,
              details,
            ) ?? true,
          ).toBe(false);
          const decisions: boolean[] = [];
          if (contents.session.request)
            contents.session.request(
              contents as unknown as WebContents,
              permission,
              (allow) => decisions.push(allow),
              details,
            );
          else decisions.push(true); // Documented Electron default, not a native-device experiment.
          expect(decisions).toEqual([false]);
        }
      }
    } finally {
      manager.dispose();
    }
  },
);

test("guest policy is installed before first load, stays partition-local and survives another window closing", async () => {
  const first = setup();
  const second = setup();
  try {
    await first.manager.command({ type: "create", id: "first", url: "https://example.com/" });
    await second.manager.command({ type: "create", id: "second", url: "https://example.org/" });
    const contents = second.guest().webContents;
    expect(first.guest().webContents.policyAtLoad).toEqual([false, false]);
    expect(contents.policyAtLoad).toEqual([false, false]);
    expect(contents.session).toBe(first.guest().webContents.session);
    expect(contents.session).toBe(sessionFor("persist:eta-browser"));
    const control = sessionFor("default");
    expect(control.check).toBeNull();
    expect(control.request).toBeNull();
    expect(control.device).toBeNull();
    first.manager.dispose();
    const decisions: boolean[] = [];
    contents.session.request?.(
      contents as unknown as WebContents,
      "notifications",
      (allow) => decisions.push(allow),
      { isMainFrame: true, requestingUrl: "https://example.org/" },
    );
    expect(decisions).toEqual([false]);
    expect(contents.url).toBe("https://example.org/");
  } finally {
    first.manager.dispose();
    second.manager.dispose();
  }
});

const devices = [
  {
    deviceType: "serial",
    origin: "https://example.com",
    device: { portId: "serial", portName: "fixture" },
  },
  {
    deviceType: "hid",
    origin: "https://example.com",
    device: { deviceId: "hid", name: "fixture", collections: [], vendorId: 1, productId: 1 },
  },
  {
    deviceType: "usb",
    origin: "https://example.com",
    device: {
      deviceId: "usb",
      configurations: [],
      deviceClass: 0,
      deviceSubclass: 0,
      deviceProtocol: 0,
      deviceVersionMajor: 1,
      deviceVersionMinor: 0,
      deviceVersionSubminor: 0,
      usbVersionMajor: 2,
      usbVersionMinor: 0,
      usbVersionSubminor: 0,
      vendorId: 1,
      productId: 1,
    },
  },
] satisfies Parameters<NonNullable<Parameters<Session["setDevicePermissionHandler"]>[0]>>[0][];

test.each(devices)("guest remembered $deviceType device permission is denied", async (details) => {
  const { manager, guest } = setup();
  try {
    await manager.command({ type: "create", id: "web", url: "https://example.com/" });
    expect(guest().webContents.session.device?.(details) ?? true).toBe(false);
  } finally {
    manager.dispose();
  }
});
