import { beforeEach, expect, test, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  windows: [] as {
    webContents: { id: number; send: ReturnType<typeof vi.fn> };
    loadURL: ReturnType<typeof vi.fn>;
    close(): void;
  }[],
  managers: new Map<
    number,
    { command: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
  >(),
  libraryListener: undefined as (() => void) | undefined,
  service: { threadFile: vi.fn(), renameThread: vi.fn(), subscribeLibrary: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
}));
vi.mock("./main/bootstrap.ts", () => ({ createDesktopApplication: async () => state.service }));
vi.mock("./main/browser/electron.ts", () => ({
  decodeBrowserCommand: (command: unknown) => command,
  createWindowBrowser: (window: { webContents: { id: number } }) => {
    const manager = { command: vi.fn(() => window.webContents.id), dispose: vi.fn() };
    state.managers.set(window.webContents.id, manager);
    return manager;
  },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      id: state.windows.length + 1,
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: vi.fn(),
    });
    destroyed = false;
    loadURL = vi.fn(async () => {});
    show = vi.fn();
    focus = vi.fn();
    constructor() {
      super();
      state.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    close() {
      this.destroyed = true;
      this.emit("closed");
      this.webContents.emit("destroyed");
    }
    static getAllWindows() {
      return state.windows.filter((window) => !(window as Window).destroyed);
    }
    static fromWebContents(contents: { id: number }) {
      return this.getAllWindows().find((window) => window.webContents.id === contents.id);
    }
  }
  return {
    BrowserWindow: Window,
    app: {
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      getAppPath: () => "/eta",
      getPath: () => "/eta/data",
      on: vi.fn(),
      quit: vi.fn(),
    },
    shell: state.shell,
    dialog: { showErrorBox: vi.fn() },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
        state.handlers.set(channel, handler),
      on: vi.fn(),
    },
  };
});
beforeEach(async () => {
  vi.resetModules();
  state.windows.length = 0;
  state.handlers.clear();
  state.managers.clear();
  state.service.threadFile.mockReset().mockResolvedValue("/eta/data/sessions/one/main.jsonl");
  state.service.subscribeLibrary.mockReset().mockImplementation((listener: () => void) => {
    state.libraryListener = listener;
    return () => {
      state.libraryListener = undefined;
    };
  });
  state.service.renameThread.mockReset().mockImplementation(async () => {
    state.libraryListener?.();
    return { id: "one", title: "Renamed" };
  });
  state.shell.openPath.mockReset().mockResolvedValue("");
  await import("./main.ts");
  await vi.waitFor(() => expect(state.windows).toHaveLength(1));
});

async function call(channel: string, sender: { webContents: { id: number } }, ...args: unknown[]) {
  return state.handlers.get(channel)!({ sender: sender.webContents }, ...args);
}

test("a thread opens in a separate window and browser commands remain scoped to their window", async () => {
  const first = state.windows[0]!;
  expect(await call("eta:thread-window", first, "one")).toEqual({ ok: true, value: undefined });
  const second = state.windows[1]!;
  expect(new URL(second.loadURL.mock.calls[0]![0]).searchParams.get("thread")).toBe("one");
  expect(await call("browser:command", first, { type: "list" })).toEqual({
    ok: true,
    value: first.webContents.id,
  });
  expect(await call("browser:command", second, { type: "list" })).toEqual({
    ok: true,
    value: second.webContents.id,
  });
  const otherManager = state.managers.get(second.webContents.id)!;
  first.close();
  expect(otherManager.dispose).not.toHaveBeenCalled();
  expect(await call("browser:command", second, { type: "list" })).toEqual({
    ok: true,
    value: second.webContents.id,
  });
});

test("default file opening surfaces OS errors and a missing thread cannot open a new window", async () => {
  const first = state.windows[0]!;
  state.shell.openPath.mockResolvedValueOnce("No associated application");
  const reply = await call("eta:thread-file", first, "one", "default");
  expect(reply).toMatchObject({ ok: false, error: { message: "No associated application" } });
  expect(state.shell.openPath).toHaveBeenCalledWith("/eta/data/sessions/one/main.jsonl");
  state.service.threadFile.mockRejectedValueOnce(new Error("Missing thread"));
  expect(await call("eta:thread-window", first, "missing")).toMatchObject({ ok: false });
  expect(state.windows).toHaveLength(1);
});

test("successful thread mutations notify every open window to refresh its catalog", async () => {
  const first = state.windows[0]!;
  await call("eta:thread-window", first, "one");
  const second = state.windows[1]!;
  expect(
    await call("eta:command", first, { type: "rename", id: "one", title: "Renamed" }),
  ).toMatchObject({ ok: true });
  expect(first.webContents.send).toHaveBeenCalledWith("eta:library-changed");
  expect(second.webContents.send).toHaveBeenCalledWith("eta:library-changed");
});

test("background title publication refreshes all windows without an IPC mutation", async () => {
  const first = state.windows[0]!;
  await call("eta:thread-window", first, "one");
  const second = state.windows[1]!;
  first.webContents.send.mockClear();
  second.webContents.send.mockClear();
  state.libraryListener?.();
  expect(first.webContents.send).toHaveBeenCalledWith("eta:library-changed");
  expect(second.webContents.send).toHaveBeenCalledWith("eta:library-changed");
});
