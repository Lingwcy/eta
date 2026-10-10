import { isCloudId } from "../../shared/bot.ts";
import { app, dialog, ipcMain, shell } from "electron";
import type { DesktopApplication } from "../bootstrap.ts";
import { commandReply, dispatchCommand } from "../ipc.ts";
import { openWithApplication } from "../platform/thread-file.ts";
import { releaseUrl } from "../platform/updater.ts";
import type { Updater } from "../platform/updater.ts";
import type { DesktopSettings } from "../../shared/settings.ts";
import { decodeBrowserCommand } from "../browser/electron.ts";
import type { createDesktopWindows } from "../windows.ts";
import { sessionId } from "./validation.ts";

export function registerDesktopIpc({
  service,
  updater,
  windows,
  notifyLibrary,
}: {
  service: () => DesktopApplication;
  updater: () => Updater | undefined;
  windows: ReturnType<typeof createDesktopWindows>;
  notifyLibrary: () => void;
}) {
  const openWindow = windows.open;
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
        updater()?.setAutoCheck((value as DesktopSettings).autoCheckUpdates !== false);
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
      const currentUpdater = updater();
      if (!currentUpdater) throw new Error("更新服务尚未就绪");
      if (action === "state") return currentUpdater.state();
      if (action === "check") return currentUpdater.check();
      if (action === "install") return currentUpdater.install();
      throw new Error("更新操作无效");
    }),
  );

  // 让渲染进程请求主进程打开某个线程窗口
  ipcMain.handle("eta:thread-window", (_event, rawId: unknown) =>
    commandReply(async () => {
      const id = sessionId(rawId);
      if (isCloudId(id)) await service().openThread(id);
      else await service().threadFile(id);
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
      const browser = windows.browserFor(event.sender);
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
}
