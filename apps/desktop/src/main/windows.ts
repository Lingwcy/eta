import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";
import type { WebContents } from "electron";
import { createWindowBrowser } from "./browser/electron.ts";
import type { BrowserManager } from "./browser/manager.ts";

export function applicationIconPath() {
  return resolve(
    app.getAppPath(),
    process.env.ETA_WEB_URL ? "renderer/public/eta-icon.png" : "dist/ui/eta-icon.png",
  );
}

export function createDesktopWindows(
  onDestroyed: (contentsId: number) => void,
  closing: () => boolean,
) {
  let window: BrowserWindow | undefined;
  const browsers = new Map<number, BrowserManager>();
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
    currentWindow.webContents.setWindowOpenHandler(({ url }) => {
      const protocol = new URL(url).protocol;
      if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") {
        void shell.openExternal(url).catch((error: unknown) => {
          dialog.showErrorBox(
            "无法打开链接",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      return { action: "deny" };
    });
    currentWindow.webContents.on("will-navigate", (event, url) => {
      const allowed = devUrl
        ? new URL(url).origin === new URL(devUrl).origin
        : new URL(url).pathname === new URL(renderTarget).pathname;
      if (!allowed) event.preventDefault();
    });
    // 监听退出一个窗口时执行 ObservationService.subscribe 退订事件流
    currentWindow.webContents.on("destroyed", () => onDestroyed(contentsId));
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
      dialog.showErrorBox(
        "Eta 页面加载失败",
        error instanceof Error ? error.message : String(error),
      );
      currentWindow.close();
    });
  }

  const browserFor = (sender: WebContents) => {
    const current = BrowserWindow.fromWebContents(sender);
    if (closing() || !current || current.isDestroyed()) throw new Error("浏览器窗口不可用");
    let browser = browsers.get(sender.id);
    if (!browser) {
      browser = createWindowBrowser(current);
      browsers.set(sender.id, browser);
    }
    return browser;
  };
  const dispose = () => {
    for (const browser of browsers.values()) browser.dispose();
    browsers.clear();
  };
  return { open: openWindow, browserFor, dispose };
}
