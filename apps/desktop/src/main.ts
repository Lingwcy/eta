import { openWithApplication } from "./main/platform/thread-file.ts";
import { processImage } from "./main/platform/images.ts";
import { resolveShellPath } from "./main/platform/shell-path.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { createDesktopApplication } from "./main/bootstrap.ts";
import type { DesktopApplication } from "./main/bootstrap.ts";
import { commandReply, dispatchCommand } from "./main/ipc.ts";
import type { AgentEvent, UpdateState } from "./bridge.ts";
import { createUpdater, releaseUrl } from "./main/platform/updater.ts";
import type { Updater } from "./main/platform/updater.ts";
import type { DesktopSettings } from "./main/service/settings/index.ts";
import { createWindowBrowser, decodeBrowserCommand } from "./main/browser/electron.ts";
import type { BrowserManager } from "./main/browser/manager.ts";

let window: BrowserWindow | undefined;
let agentService: DesktopApplication | undefined;
let updater: Updater | undefined;
let quitting = false;
let ready = false;
let startup: Promise<void> | undefined;
const browsers = new Map<number, BrowserManager>();

type Watch = { token: symbol; unsubscribe?: () => void };
/**
 * 按窗口维护活跃会话订阅的二级账本：
 * Map<contentsId (窗口 ID), Map<subscriptionId (订阅 UUID), Watch (订阅实例)>>
 * 外层key按窗口划分：窗口销毁时，可通过 contents.id 批量注销其关联的所有监听，避免内存泄漏。
 * 内层key按 subscriptionId 区分：同一窗口内不同组件、Tab 或后台活动监听器可独立订阅与退订。
 */
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

/**
 * 打开窗口，不传会话线程ID打开默认窗口传入打开会话窗口
 * @param threadId 可选，会话线程ID
 * @returns
 */
function openWindow(threadId?: string) {
  if (!threadId && window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  // 生产环境web url
  const rendererPath = resolve(app.getAppPath(), "dist/ui/index.html");
  // 开发环境web url scripts/dev-runner.ts 先把 Vite dev server 跑起来，再把地址传进 ETA_WEB_URL
  const devUrl = process.env.ETA_WEB_URL;
  // 选择确定的渲染路径 打包后用 pathToFileURL 转成 file:// URL
  const renderTarget = devUrl ?? pathToFileURL(rendererPath).href;
  // 窗口配置
  const currentWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    title: "Eta",
    icon: applicationIconPath(),
    backgroundColor: "#e9e9e9",
    // hiddenInset + trafficLightPosition: {x:16,y:13}：macOS 上隐藏系统标题栏，
    // 由渲染进程自己画顶栏；红黄绿三个灯手动内缩到 16/13，跟自绘顶栏对齐。Windows/Linux 走默认标题栏
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 13 } }
      : {}),
    //能力边界 必须经过 dist/electron/preload.cjs 用 contextBridge 暴露的 window.eta
    webPreferences: {
      preload: resolve(app.getAppPath(), "dist/electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 只有第一次调用会写入
  window ??= currentWindow;
  // browsers 账本是 webContents.id → BrowserManager，
  // 也就是每个窗口独立一套内嵌浏览器页签（manager.ts 里的 pages Map）
  // 这里只是登记管理器对象本身，真正的 WebContentsView 是等渲染进程发 browser:command {type:"create"} 时才惰性建的。
  const contentsId = currentWindow.webContents.id;
  browsers.set(contentsId, createWindowBrowser(currentWindow));

  // // 窗口自己的页面一旦要重新加载，先把该窗口的内嵌网页全部关掉
  // currentWindow.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
  //   if (!isMainFrame) return;
  //   browsers.get(contentsId)?.dispose();
  //   browsers.delete(contentsId);
  // });
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  currentWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = devUrl
      ? new URL(url).origin === new URL(devUrl).origin
      : new URL(url).pathname === new URL(renderTarget).pathname;
    if (!allowed) event.preventDefault();
  });
  // 监听退出一个窗口时执行 ObservationService.subscribe 退订事件流
  currentWindow.webContents.on("destroyed", () => {
    const sessions = watchers.get(currentWindow.webContents.id);
    if (!sessions) return;
    // 把这个窗口产生的所有订阅全注销
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
  const url = new URL(renderTarget);
  if (threadId) url.searchParams.set("thread", threadId);
  const loaded = currentWindow.loadURL(url.href);
  void loaded.catch((error: unknown) => {
    dialog.showErrorBox("Eta 页面加载失败", error instanceof Error ? error.message : String(error));
    currentWindow.close();
  });
}

function notifyUpdate(state: UpdateState) {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("eta:update-state", state);
}

function notifyLibrary() {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("eta:library-changed");
}

// 供渲染进程通过 "eta:command" 发送业务命令
ipcMain.handle("eta:command", (_event, command: unknown) =>
  commandReply(async () => {
    const value = await dispatchCommand(service(), command);
    if (
      typeof command === "object" &&
      command !== null &&
      "type" in command &&
      command.type === "settings"
    ) {
      // dispatchCommand 已校验命令，settings 命令一定返回最新的设置
      updater?.setAutoCheck((value as DesktopSettings).autoCheckUpdates !== false);
      notifyLibrary();
    }
    return value;
  }),
);

// 关于页：版本信息与更新生命周期
ipcMain.handle("eta:update", (_event, action: unknown) =>
  commandReply(async () => {
    if (action === "app-info") return { version: app.getVersion() };
    if (action === "release-page") return shell.openExternal(releaseUrl);
    if (!updater) throw new Error("更新服务尚未就绪");
    if (action === "state") return updater.state();
    if (action === "check") return updater.check();
    if (action === "install") return updater.install();
    throw new Error("更新操作无效");
  }),
);

// 让渲染进程请求主进程打开某个线程窗口
ipcMain.handle("eta:thread-window", (_event, rawId: unknown) =>
  commandReply(async () => {
    const id = sessionId(rawId);
    await service().threadFile(id);
    openWindow(id);
  }),
);
// 用来打开某个会话的 main.jsonl 文件,按 mode 决定处理方式
ipcMain.handle("eta:thread-file", (_event, rawId: unknown, mode: unknown) =>
  commandReply(async () => {
    const file = await service().threadFile(sessionId(rawId));
    // 在系统文件管理器中显示该文件
    if (mode === "reveal") {
      shell.showItemInFolder(file);
      return;
    }
    // 用系统默认应用打开文件,如果系统返回错误，就抛出异常
    if (mode === "default") {
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
      return;
    }
    // 弹出文件选择框，让用户选择一个应用来打开文件
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
    // 抛出打开方式无效错误
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
// 用户选中一个已有文件夹后，会把这个路径注册为 Eta 项目，并返回项目对象
ipcMain.handle("eta:choose-project", () =>
  commandReply(async () => {
    const application = service();
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const project = await application.registerProject(result.filePaths[0]);
    return project;
  }),
);

// 弹出dialog选择一个路径
ipcMain.handle("eta:choose-directory", () =>
  commandReply(async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }),
);

ipcMain.on("agent:watch", (event, rawId: unknown, rawSubscriptionId: unknown) => {
  let id: string;
  let subscriptionId: string;
  // 参数校验
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
  // 安全发送器
  const send = (agentEvent: AgentEvent) => {
    // 确保窗口还没被用户关闭，避免对已销毁的 WebContents 发送 IPC导致崩溃。
    // Token校验。确保当前的订阅依然是发起该请求时的同一个订阅，防止订阅在短时间内被取消重连时产生串话/脏消息。
    if (!contents.isDestroyed() && sessions?.get(subscriptionId)?.token === watch.token)
      contents.send("agent:event", { sessionId: id, subscriptionId, event: agentEvent });
  };
  // 加上 void 明确向编译器声明 这里有意将其放入后台执行（Fire-and-Forget），不需要等待它完成。
  // 在同步执行时抛出异常（例如应用退出抛出RuntimeClosing 或尚未初始化抛出 Agent 尚未就绪） 由catch统一捕获
  void Promise.resolve()
    // 建立底层订阅通道
    .then(() =>
      service().subscribe(
        id,
        (value) => send({ type: "snapshot", value }),
        (message) => send({ type: "error", message }),
      ),
    )
    // subscribe 会返回 unsubscribe 取消订阅函数
    .then((unsubscribe) => {
      // 如果这期间renderer把窗口关了或者已经调用了 unwatch（从 Map中删除了该项或被新订阅替代）；
      if (contents.isDestroyed() || sessions?.get(subscriptionId)?.token !== watch.token)
        unsubscribe();
      // 如果依然有效：将 unsubscribe 保存到 watch.unsubscribe
      // 上。后续当渲染进程主动发送 agent:unwatch
      // 时，stopWatching 就能调用该函数完成清理。
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
    updater?.dispose();
    for (const browser of browsers.values()) browser.dispose();
    browsers.clear();
    for (const [contentsId, subscriptions] of watchers)
      for (const id of subscriptions.keys()) stopWatching(contentsId, id);
    void (startup ?? Promise.resolve())
      .then(() => agentService?.close())
      .catch((error: unknown) => {
        console.error("Eta shutdown failed", error);
      })
      // 推迟到下一个宏任务：清理很快完成时，微任务里的 app.quit() 会重入仍在执行的 Browser::Quit，
      // 外层随后把 is_quitting_ 覆盖回 false，窗口全部关闭后进程却不退出（SIGTERM 和 quitAndInstall 都会触发）
      .finally(() => setImmediate(() => app.quit()));
  });

  // 记录启动 Promise，用于在 before-quit 钩子中等待启动完成后再安全关闭服务
  startup = app
    .whenReady()
    .then(async () => {
      // 1. 修复 GUI 启动时的 PATH 环境变量：
      // macOS 从 Dock/Finder 启动时不会加载用户的 Shell 配置文件（.zshrc/.bash_profile），
      // 导致缺少 node/git/brew 等路径。这里动态解析并补全系统 PATH，保证 Agent 工具能正常运行。
      const shellPath = await resolveShellPath();
      if (shellPath) process.env.PATH = shellPath;

      // 2. 设置应用图标（macOS Dock 栏）
      app.dock?.setIcon(applicationIconPath());

      // 3. 计算应用根目录与工作区默认路径：
      // 打包后为应用安装目录，开发环境下回退到 Monorepo 仓库根目录
      const root = app.isPackaged ? app.getAppPath() : resolve(app.getAppPath(), "../..");
      const cwd = process.env.ETA_WORKSPACE ?? (app.isPackaged ? app.getPath("home") : root);

      // 4. 初始化 Agent 核心业务服务（提供线程调度、存储、模型调用、会话管理等全部后台能力）
      agentService = await createDesktopApplication(
        root,
        cwd,
        app.getPath("userData"),
        (url) => shell.openExternal(url), // 外部浏览器打开链接
        processImage, // 图片预处理（尺寸调整、格式转换）
        (path) => shell.showItemInFolder(path), // 在系统文件管理器中定位文件
        async (path) => {
          // 用系统默认程序打开文件，若失败则抛出异常
          const error = await shell.openPath(path);
          if (error) throw new Error(error);
        },
      );

      // 5. 监听项目与会话库变动，当会话/项目发生增删改时广播通知所有窗口刷新
      agentService.subscribeLibrary(notifyLibrary);

      // 6. 自动更新：只有打包后的应用带有 app-update.yml，开发模式下标记为不支持
      updater = createUpdater({
        // 按需加载，开发模式不引入 electron-updater
        backend: app.isPackaged ? (await import("electron-updater")).autoUpdater : undefined,
        autoCheck: false,
        broadcast: notifyUpdate,
      });

      // 7. 标记就绪状态；若启动过程中未收到退出信号，则打开初始窗口
      ready = true;
      if (!quitting) openWindow();

      // 8. 读取设置后再开启自动检查；更新器出错不能阻断启动
      void agentService.library().then(
        ({ settings }) => updater?.setAutoCheck(settings.autoCheckUpdates !== false),
        (error: unknown) => console.error("Eta update schedule failed", error),
      );
    })
    .catch((error: unknown) => {
      // 启动阶段致命异常兜底：弹窗提示用户并退出应用，防止出现僵尸进程
      dialog.showErrorBox("Eta 启动失败", error instanceof Error ? error.message : String(error));
      app.quit();
    });
}
