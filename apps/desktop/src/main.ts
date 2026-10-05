import { openWithApplication } from "./main/platform/thread-file.ts";
import { processImage } from "./main/platform/images.ts";
import { resolveShellPath } from "./main/platform/shell-path.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createDesktopApplication } from "./main/bootstrap.ts";
import type { DesktopApplication } from "./main/bootstrap.ts";
import { commandReply, dispatchCommand } from "./main/ipc.ts";
import type { AgentEvent } from "./bridge.ts";
import { createWindowBrowser, decodeBrowserCommand } from "./main/browser/electron.ts";
import type { BrowserManager } from "./main/browser/manager.ts";

let window: BrowserWindow | undefined;
let agentService: DesktopApplication | undefined;
let quitting = false;
let ready = false;
let startup: Promise<void> | undefined;
const browsers = new Map<number, BrowserManager>();

type Watch = { token: symbol; unsubscribe?: () => void };
const watchers = new Map<number, Map<string, Watch>>();

function service() {
  if (quitting) throw new Error("RuntimeClosing: Eta 正在退出");
  if (!agentService) throw new Error("Agent 尚未就绪");
  return agentService;
}

function sessionId(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("会话 ID 无效");
  return value;
}

function stopWatching(contentsId: number, id: string) {
  const sessions = watchers.get(contentsId);
  const watch = sessions?.get(id);
  if (!watch) return;
  sessions?.delete(id);
  watch.unsubscribe?.();
  if (sessions?.size === 0) watchers.delete(contentsId);
}

function applicationIconPath() {
  return resolve(
    app.getAppPath(),
    process.env.ETA_WEB_URL ? "renderer/public/eta-icon.png" : "dist/ui/eta-icon.png",
  );
}

function openWindow(threadId?: string) {
  if (!threadId && window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  const rendererPath = resolve(app.getAppPath(), "dist/ui/index.html");
  const devUrl = process.env.ETA_WEB_URL;
  const target = devUrl ?? pathToFileURL(rendererPath).href;
  const currentWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: "Eta",
    icon: applicationIconPath(),
    backgroundColor: "#e9e9e9",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 13 } }
      : {}),
    webPreferences: {
      preload: resolve(app.getAppPath(), "dist/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window ??= currentWindow;
  const contentsId = currentWindow.webContents.id;
  browsers.set(contentsId, createWindowBrowser(currentWindow));
  currentWindow.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    browsers.get(contentsId)?.dispose();
    browsers.delete(contentsId);
  });
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  currentWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = devUrl
      ? new URL(url).origin === new URL(devUrl).origin
      : new URL(url).pathname === new URL(target).pathname;
    if (!allowed) event.preventDefault();
  });
  currentWindow.webContents.on("destroyed", () => {
    const sessions = watchers.get(currentWindow.webContents.id);
    if (!sessions) return;
    for (const [id, watch] of sessions) {
      sessions.delete(id);
      watch.unsubscribe?.();
    }
    watchers.delete(currentWindow.webContents.id);
  });
  currentWindow.on("closed", () => {
    browsers.get(contentsId)?.dispose();
    browsers.delete(contentsId);
    if (window === currentWindow)
      window = BrowserWindow.getAllWindows().find(
        (value) => value !== currentWindow && !value.isDestroyed(),
      );
  });
  const url = new URL(target);
  if (threadId) url.searchParams.set("thread", threadId);
  const loaded = currentWindow.loadURL(url.href);
  void loaded.catch((error: unknown) => {
    dialog.showErrorBox("Eta 页面加载失败", error instanceof Error ? error.message : String(error));
    currentWindow.close();
  });
}

function notifyLibrary() {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("eta:library-changed");
}

ipcMain.handle("eta:command", (_event, command: unknown) =>
  commandReply(async () => {
    const value = await dispatchCommand(service(), command);
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "settings"
    ) {
      notifyLibrary();
    }
    return value;
  }),
);
ipcMain.handle("eta:thread-window", (_event, rawId: unknown) =>
  commandReply(async () => {
    const id = sessionId(rawId);
    await service().threadFile(id);
    openWindow(id);
  }),
);
ipcMain.handle("eta:thread-file", (_event, rawId: unknown, mode: unknown) =>
  commandReply(async () => {
    const file = await service().threadFile(sessionId(rawId));
    if (mode === "reveal") {
      shell.showItemInFolder(file);
      return;
    }
    if (mode === "default") {
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
      return;
    }
    if (mode !== "choose") throw new Error("打开方式无效");
    const result = await dialog.showOpenDialog({
      title: "选择打开会话记录的应用",
      ...(process.platform === "darwin"
        ? { defaultPath: "/Applications", filters: [{ name: "应用", extensions: ["app"] }] }
        : process.platform === "win32"
          ? { filters: [{ name: "应用", extensions: ["exe"] }] }
          : {}),
      properties: ["openFile"],
    });
    if (!result.canceled && result.filePaths[0])
      await openWithApplication(file, result.filePaths[0]);
  }),
);
ipcMain.handle("browser:command", (event, raw: unknown) =>
  commandReply(() => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (quitting || !senderWindow || senderWindow.isDestroyed())
      throw new Error("浏览器窗口不可用");
    let browser = browsers.get(event.sender.id);
    if (!browser) {
      browser = createWindowBrowser(senderWindow);
      browsers.set(event.sender.id, browser);
    }
    return browser.command(decodeBrowserCommand(raw));
  }),
);
ipcMain.handle("eta:choose-project", () =>
  commandReply(async () => {
    const application = service();
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = await application.registerProject(result.filePaths[0]);
    return project;
  }),
);
ipcMain.handle("eta:choose-directory", () =>
  commandReply(async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }),
);

ipcMain.on("agent:watch", (event, rawId: unknown, rawSubscriptionId: unknown) => {
  let id: string;
  let subscriptionId: string;
  try {
    id = sessionId(rawId);
    subscriptionId = sessionId(rawSubscriptionId);
  } catch (error) {
    event.sender.send("agent:event", {
      sessionId: typeof rawId === "string" ? rawId : "",
      subscriptionId: typeof rawSubscriptionId === "string" ? rawSubscriptionId : "",
      event: { type: "error", message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  const contents = event.sender;
  let sessions = watchers.get(contents.id);
  if (!sessions) watchers.set(contents.id, (sessions = new Map()));
  if (sessions.has(subscriptionId)) return;
  const watch: Watch = { token: Symbol() };
  sessions.set(subscriptionId, watch);
  const send = (agentEvent: AgentEvent) => {
    if (!contents.isDestroyed() && sessions?.get(subscriptionId)?.token === watch.token)
      contents.send("agent:event", { sessionId: id, subscriptionId, event: agentEvent });
  };
  void Promise.resolve()
    .then(() =>
      service().subscribe(
        id,
        (value) => send({ type: "snapshot", value }),
        (message) => send({ type: "error", message }),
      ),
    )
    .then((unsubscribe) => {
      if (contents.isDestroyed() || sessions?.get(subscriptionId)?.token !== watch.token)
        unsubscribe();
      else watch.unsubscribe = unsubscribe;
    })
    .catch((error: unknown) => {
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      stopWatching(contents.id, subscriptionId);
    });
});

ipcMain.on("agent:unwatch", (event, rawId: unknown) => {
  if (typeof rawId === "string") stopWatching(event.sender.id, rawId);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (ready) openWindow();
  });
  app.on("activate", () => {
    if (ready) openWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    for (const browser of browsers.values()) browser.dispose();
    browsers.clear();
    for (const [contentsId, subscriptions] of watchers)
      for (const id of subscriptions.keys()) stopWatching(contentsId, id);
    void (startup ?? Promise.resolve())
      .then(() => agentService?.close())
      .catch((error: unknown) => {
        console.error("Eta shutdown failed", error);
      })
      .finally(() => app.quit());
  });

  startup = app
    .whenReady()
    .then(async () => {
      const shellPath = await resolveShellPath();
      if (shellPath) process.env.PATH = shellPath;
      app.dock?.setIcon(applicationIconPath());
      const root = app.isPackaged ? app.getAppPath() : resolve(app.getAppPath(), "../..");
      const cwd = process.env.ETA_WORKSPACE ?? (app.isPackaged ? app.getPath("home") : root);
      agentService = await createDesktopApplication(
        root,
        cwd,
        app.getPath("userData"),
        (url) => shell.openExternal(url),
        processImage,
        (path) => shell.showItemInFolder(path),
        async (path) => {
          const error = await shell.openPath(path);
          if (error) throw new Error(error);
        },
      );
      agentService.subscribeLibrary(notifyLibrary);
      ready = true;
      if (!quitting) openWindow();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox("Eta 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    });
}
