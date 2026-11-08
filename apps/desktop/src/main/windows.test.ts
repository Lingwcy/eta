import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, expect, test, vi } from "vite-plus/test";
const fake = vi.hoisted(() => {
  class Window {
    static all: Window[] = [];
    readonly webContents = {
      id: Window.all.length + 1,
      setWindowOpenHandler() {},
      on() {},
      send: vi.fn(),
    };
    listeners = new Map<string, () => void>();
    destroyed = false;
    shows = 0;
    setBackgroundColor = vi.fn();
    setTitleBarOverlay = vi.fn();
    focuses = 0;
    readonly options: BrowserWindowConstructorOptions;
    constructor(options: BrowserWindowConstructorOptions = {}) {
      this.options = options;
      Window.all.push(this);
    }
    static getAllWindows() {
      return Window.all;
    }
    on(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      this.shows++;
    }
    focus() {
      this.focuses++;
    }
    close() {
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
    loadURL() {
      return Promise.resolve();
    }
  }
  return { Window };
});
vi.mock("electron", () => ({
  app: { getAppPath: () => "/tmp/eta" },
  BrowserWindow: fake.Window,
  dialog: {},
  shell: {},
}));
vi.mock("./browser/electron.ts", () => ({ createWindowBrowser: () => ({ dispose() {} }) }));
vi.mock("./i18n.ts", () => ({ t: (key: string) => key, errorMessage: String }));
import { createDesktopWindows } from "./windows.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  fake.Window.all = [];
});

test.each(["win32", "darwin", "linux"])(
  "%s uses the same window chrome for the main, detached and reopened windows",
  (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    const windows = createDesktopWindows(
      () => {},
      () => false,
      () => ({ preference: "light", resolved: "light", revision: 0 }),
    );
    try {
      windows.open();
      windows.open("another-thread");
      for (const window of fake.Window.all) window.close();
      windows.open();
      expect(fake.Window.all).toHaveLength(3);
      for (const { options } of fake.Window.all) {
        if (platform === "win32") {
          expect(options.titleBarStyle).toBe("hidden");
          expect(options.titleBarOverlay).toEqual({
            color: "#e9e9e9",
            symbolColor: "#262626",
            height: 42,
          });
          expect(options.autoHideMenuBar).toBe(true);
          expect(options.trafficLightPosition).toBeUndefined();
        } else if (platform === "darwin") {
          expect(options.titleBarStyle).toBe("hiddenInset");
          expect(options.trafficLightPosition).toEqual({ x: 16, y: 13 });
          expect(options.titleBarOverlay).toBeUndefined();
          expect(options.autoHideMenuBar).toBeUndefined();
        } else {
          expect(options.titleBarStyle).toBeUndefined();
          expect(options.titleBarOverlay).toBeUndefined();
          expect(options.autoHideMenuBar).toBeUndefined();
        }
        // Keep native resizing and the trusted preload boundary on every platform.
        expect(options.frame).not.toBe(false);
        expect(options.webPreferences).toMatchObject({
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        });
      }
    } finally {
      windows.dispose();
    }
  },
);

test("closing the main window selects another chat window rather than an auxiliary panel", () => {
  fake.Window.all = [];
  const windows = createDesktopWindows(
    () => {},
    () => false,
    () => ({ preference: "light", resolved: "light", revision: 0 }),
  );
  try {
    windows.open();
    const first = fake.Window.all[0]!;
    const overlay = new fake.Window();
    windows.open("another-thread");
    const second = fake.Window.all[2]!;
    first.close();
    windows.open();
    expect(second.shows).toBe(1);
    expect(second.focuses).toBe(1);
    expect(overlay.shows).toBe(0);
    expect(overlay.focuses).toBe(0);
  } finally {
    windows.dispose();
    fake.Window.all = [];
  }
});

test.each(["win32", "darwin", "linux"])(
  "%s updates only Eta windows and seeds detached and reopened windows",
  (platform) => {
    vi.stubGlobal("process", { ...process, platform });
    let appearance = { preference: "dark" as const, resolved: "dark" as const, revision: 1 };
    const windows = createDesktopWindows(
      () => {},
      () => false,
      () => appearance,
    );
    try {
      windows.open();
      windows.open("detached");
      const overlay = new fake.Window();
      for (const current of fake.Window.all.slice(0, 2)) {
        expect(current.options.backgroundColor).toBe("#191a1c");
        expect(current.options.webPreferences?.additionalArguments).toEqual([
          "--eta-appearance=dark:dark:1",
        ]);
      }
      const light = { preference: "light" as const, resolved: "light" as const, revision: 2 };
      windows.updateAppearance(light);
      for (const current of fake.Window.all.slice(0, 2)) {
        expect(current.setBackgroundColor).toHaveBeenLastCalledWith("#e9e9e9");
        expect(current.webContents.send).toHaveBeenLastCalledWith("eta:appearance-changed", light);
        expect(current.setTitleBarOverlay).toHaveBeenCalledTimes(platform === "win32" ? 1 : 0);
      }
      expect(overlay.setBackgroundColor).not.toHaveBeenCalled();
      expect(overlay.webContents.send).not.toHaveBeenCalled();
      for (const current of fake.Window.all.slice(0, 2)) current.close();
      appearance = { ...appearance, revision: 3 };
      windows.open();
      expect(fake.Window.all.at(-1)?.options.webPreferences?.additionalArguments).toEqual([
        "--eta-appearance=dark:dark:3",
      ]);
    } finally {
      windows.dispose();
    }
  },
);
