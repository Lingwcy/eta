import { expect, test, vi } from "vite-plus/test";
const fake = vi.hoisted(() => {
  class Window {
    static all: Window[] = [];
    readonly webContents = { id: Window.all.length + 1, setWindowOpenHandler() {}, on() {} };
    listeners = new Map<string, () => void>();
    destroyed = false;
    shows = 0;
    focuses = 0;
    constructor() {
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
test("closing the main window selects another chat window rather than an auxiliary panel", () => {
  fake.Window.all = [];
  const windows = createDesktopWindows(
    () => {},
    () => false,
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
