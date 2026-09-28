import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createAgentService } from "./agent/create-service.ts";
import type { MemoryHarnessService } from "./agent/memory-harness.ts";
import type { AgentEvent } from "./bridge.ts";

let window: BrowserWindow | undefined;
let agentService: MemoryHarnessService | undefined;
let quitting = false;
let ready = false;

type Watch = { token: symbol; unsubscribe?: () => void };
const watchers = new Map<number, Map<string, Watch>>();

function service() {
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

function openWindow() {
  if (window && !window.isDestroyed()) {
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
    webPreferences: {
      preload: resolve(app.getAppPath(), "dist/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window = currentWindow;
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
    if (window === currentWindow) window = undefined;
  });
  const loaded = devUrl ? currentWindow.loadURL(target) : currentWindow.loadFile(rendererPath);
  void loaded.catch((error: unknown) => {
    dialog.showErrorBox("Eta 页面加载失败", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

ipcMain.handle("agent:create-session", () => service().create());

ipcMain.handle("agent:submit", (_event, rawId: unknown, rawPrompt: unknown) => {
  if (typeof rawPrompt !== "string" || !rawPrompt.trim()) throw new Error("请输入有效消息");
  return service().submit(sessionId(rawId), rawPrompt.trim());
});

ipcMain.handle("agent:stop", (_event, rawId: unknown) => service().stop(sessionId(rawId)));
ipcMain.handle("agent:delete-session", async (_event, rawId: unknown) => {
  const id = sessionId(rawId);
  for (const contentsId of watchers.keys()) stopWatching(contentsId, id);
  await service().delete(id);
});

ipcMain.on("agent:watch", (event, rawId: unknown) => {
  let id: string;
  try {
    id = sessionId(rawId);
  } catch (error) {
    event.sender.send("agent:event", {
      sessionId: typeof rawId === "string" ? rawId : "",
      event: { type: "error", message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  const contents = event.sender;
  let sessions = watchers.get(contents.id);
  if (!sessions) watchers.set(contents.id, (sessions = new Map()));
  if (sessions.has(id)) return;
  const watch: Watch = { token: Symbol() };
  sessions.set(id, watch);
  const send = (agentEvent: AgentEvent) => {
    if (!contents.isDestroyed()) contents.send("agent:event", { sessionId: id, event: agentEvent });
  };
  void service()
    .subscribe(
      id,
      (value) => send({ type: "snapshot", value }),
      (message) => send({ type: "error", message }),
    )
    .then((unsubscribe) => {
      if (contents.isDestroyed() || sessions?.get(id)?.token !== watch.token) unsubscribe();
      else watch.unsubscribe = unsubscribe;
    })
    .catch((error: unknown) => {
      stopWatching(contents.id, id);
      send({ type: "error", message: error instanceof Error ? error.message : String(error) });
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
    void (agentService?.close() ?? Promise.resolve()).finally(() => app.quit());
  });

  void app
    .whenReady()
    .then(async () => {
      const root = resolve(app.getAppPath(), "../..");
      const cwd = process.env.ETA_WORKSPACE ?? (app.isPackaged ? app.getPath("home") : root);
      agentService = await createAgentService(root, cwd);
      ready = true;
      if (!quitting) openWindow();
    })
    .catch((error: unknown) => {
      dialog.showErrorBox("Eta 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    });
}
