import { resolve } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { processImage } from "@eta/core/node/images";
import { resolveShellPath } from "./main/platform/shell-path.ts";
import { createDesktopApplication } from "./main/bootstrap.ts";
import type { DesktopApplication } from "./main/bootstrap.ts";
import type { UpdateState } from "./bridge.ts";
import { createUpdater } from "./main/platform/updater.ts";
import type { Updater } from "./main/platform/updater.ts";
import { applicationIconPath, createDesktopWindows } from "./main/windows.ts";
import { createAgentSubscriptions } from "./main/ipc/subscriptions.ts";
import { registerDesktopIpc } from "./main/ipc/handlers.ts";

let agentService: DesktopApplication | undefined;
let updater: Updater | undefined;
let quitting = false;
let ready = false;
let startup: Promise<void> | undefined;

function service() {
  if (quitting) throw new Error("RuntimeClosing: Eta 正在退出");
  if (!agentService) throw new Error("Agent 尚未就绪");
  return agentService;
}

const subscriptions = createAgentSubscriptions(service);
const windows = createDesktopWindows(subscriptions.disposeWindow, () => quitting);
const openWindow = windows.open;

function notifyUpdate(state: UpdateState) {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("eta:update-state", state);
}

function notifyLibrary() {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send("eta:library-changed");
}

registerDesktopIpc({ service, updater: () => updater, windows, notifyLibrary });

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
    windows.dispose();
    subscriptions.dispose();
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
