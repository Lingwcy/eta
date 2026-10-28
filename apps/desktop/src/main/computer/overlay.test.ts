import { afterEach, expect, test, vi } from "vite-plus/test";

const fake = vi.hoisted(() => {
  class Events {
    listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    on(name: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }
    once(name: string, listener: (...args: unknown[]) => void) {
      const once = (...args: unknown[]) => {
        this.removeListener(name, once);
        listener(...args);
      };
      return this.on(name, once);
    }
    removeListener(name: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((v) => v !== listener),
      );
      return this;
    }
    emit(name: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
  }
  class Window extends Events {
    static all: Window[] = [];
    destroyed = false;
    visible = false;
    loading = true;
    shown = 0;
    resolve!: () => void;
    webContents = Object.assign(new Events(), {
      mainFrame: {},
      sent: [] as unknown[],
      send: (_channel: string, state: unknown) => this.webContents.sent.push(state),
      setWindowOpenHandler() {},
      isLoading: () => this.loading,
    });
    constructor(readonly options: Record<string, unknown>) {
      super();
      Window.all.push(this);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setIgnoreMouseEvents() {}
    setPosition() {}
    isDestroyed() {
      return this.destroyed;
    }
    getBounds() {
      return { x: 0, y: 0, width: 384, height: 264 };
    }
    loadURL() {
      return new Promise<void>((resolve) => {
        this.resolve = () => {
          this.loading = false;
          resolve();
        };
      });
    }
    showInactive() {
      this.visible = true;
      this.shown++;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
      this.emit("closed");
    }
  }
  return {
    Window,
    ipc: new Events(),
    screen: Object.assign(new Events(), {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    }),
  };
});
vi.mock("electron", () => ({ BrowserWindow: fake.Window, ipcMain: fake.ipc, screen: fake.screen }));
vi.mock("../i18n.ts", () => ({ t: (key: string) => key }));
import { createComputerOverlay } from "./overlay.ts";

const overlays: ReturnType<typeof createComputerOverlay>[] = [];
afterEach(() => {
  for (const overlay of overlays.splice(0)) overlay.dispose();
  fake.Window.all = [];
  vi.useRealTimers();
});
function fixture() {
  const stopped: string[] = [],
    overlay = createComputerOverlay("/compiled", async (id) => {
      stopped.push(id);
    });
  overlays.push(overlay);
  const bounds = { x: -300, y: 40, width: 600, height: 400 };
  const pointer = {
    snapshot: "snapshot",
    windowId: 42,
    point: { x: -200, y: 60 },
    bounds,
    phase: "up" as const,
    visible: true,
  };
  return { overlay, stopped, pointer };
}

test("late loads, frames and stop messages from a retired overlay cannot affect its replacement", async () => {
  const f = fixture();
  f.overlay.update({ type: "start", id: "old" });
  const old = fake.Window.all[0]!;
  f.overlay.update({ type: "end", id: "old" });
  f.overlay.update({ type: "start", id: "new" });
  const current = fake.Window.all[1]!;
  old.resolve();
  await Promise.resolve();
  expect(old.shown).toBe(0);
  f.overlay.update({
    type: "frame",
    id: "old",
    image: { type: "image", data: "old", mimeType: "image/png" },
  });
  fake.ipc.emit(
    "eta:computer-overlay-stop",
    { sender: old.webContents, senderFrame: old.webContents.mainFrame },
    "new",
  );
  expect(f.stopped).toEqual([]);
  expect(current.isDestroyed()).toBe(false);
  current.resolve();
  await Promise.resolve();
  expect(current.shown).toBe(1);
  expect(JSON.stringify(current.webContents.sent)).not.toContain('"data":"old"');
  fake.ipc.emit(
    "eta:computer-overlay-stop",
    { sender: current.webContents, senderFrame: {} },
    "new",
  );
  expect(f.stopped).toEqual([]);
  fake.ipc.emit(
    "eta:computer-overlay-stop",
    { sender: current.webContents, senderFrame: current.webContents.mainFrame },
    "new",
  );
  expect(f.stopped).toEqual(["new"]);
  expect(current.isDestroyed()).toBe(true);
});

test("off-Space input stays in the preview; visible pointer hides after its bounded feedback interval and all windows close on end", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.overlay.update({ type: "start", id: "one" });
  f.overlay.update({ type: "pointer", id: "one", pointer: { ...f.pointer, visible: false } });
  expect(fake.Window.all).toHaveLength(1);
  f.overlay.update({ type: "pointer", id: "one", pointer: f.pointer });
  const cursor = fake.Window.all[1]!;
  cursor.resolve();
  await Promise.resolve();
  expect(cursor.visible).toBe(true);
  vi.advanceTimersByTime(900);
  expect(cursor.visible).toBe(false);
  f.overlay.update({ type: "pointer", id: "one", pointer: f.pointer });
  expect(cursor.visible).toBe(true);
  f.overlay.update({ type: "end", id: "one" });
  expect(fake.Window.all.every((w) => w.isDestroyed())).toBe(true);
  expect(f.stopped).toEqual([]);
  expect(fake.ipc.listeners.get("eta:computer-overlay-stop")).toEqual([]);
});
