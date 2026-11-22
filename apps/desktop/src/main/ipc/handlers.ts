import { stat } from "node:fs/promises";
import { Schema } from "effect";
import { CoreError } from "@eta/core/service/errors";
import type { createAppearanceController } from "../platform/appearance.ts";
import { LocalizedError } from "../../shared/i18n/messages.ts";
import { isCloudId } from "../../shared/bot.ts";
import { app, dialog, ipcMain, shell } from "electron";
import type { DesktopApplication } from "../bootstrap.ts";
import { commandReply, dispatchCommand } from "../ipc.ts";
import { detectInstalledEditors, openFileWithEditor } from "../platform/external-editors.ts";
import { openWithApplication } from "../platform/thread-file.ts";
import { releaseUrl } from "../platform/updater.ts";
import type { Updater } from "../platform/updater.ts";
import type { DesktopSettings } from "../../shared/settings.ts";
import { decodeBrowserCommand } from "../browser/electron.ts";
import type { createDesktopWindows } from "../windows.ts";
import { sessionId } from "./validation.ts";
import { mainI18n, t } from "../i18n.ts";
import { defaultLocale } from "../../shared/i18n/locales.ts";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const OpenFileTargetSchema = Schema.Struct({
  workspaceId: Schema.optional(Schema.NonEmptyString),
  path: Schema.NonEmptyString,
  line: Schema.optional(PositiveInt),
  column: Schema.optional(PositiveInt),
  mode: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("reveal") }),
    Schema.Struct({ kind: Schema.Literal("default") }),
    Schema.Struct({ kind: Schema.Literal("choose") }),
    Schema.Struct({ kind: Schema.Literal("editor"), editorId: Schema.NonEmptyString }),
  ]),
});
const decodeOpenFileTarget = Schema.decodeUnknownSync(OpenFileTargetSchema, {
  onExcessProperty: "error",
});

async function chooseAndOpenWithApplication(file: string) {
  const result = await dialog.showOpenDialog({
    title: t("native:dialog.chooseApplication"),
    ...(process.platform === "darwin"
      ? {
          defaultPath: "/Applications",
          filters: [{ name: t("native:dialog.application"), extensions: ["app"] }],
        }
      : process.platform === "win32"
        ? { filters: [{ name: t("native:dialog.application"), extensions: ["exe"] }] }
        : {}),
    properties: ["openFile"],
  });
  if (!result.canceled && result.filePaths[0]) await openWithApplication(file, result.filePaths[0]);
}

export function registerDesktopIpc({
  service,
  updater,
  windows,
  notifyLibrary,
  appearance,
}: {
  service: () => DesktopApplication;
  updater: () => Updater | undefined;
  windows: ReturnType<typeof createDesktopWindows>;
  notifyLibrary: () => void;
  appearance: ReturnType<typeof createAppearanceController>;
}) {
  const openWindow = windows.open;
  ipcMain.handle("eta:appearance", () => commandReply(async () => appearance.snapshot()));
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
        await mainI18n.changeLanguage((value as DesktopSettings).locale ?? defaultLocale);
        notifyLibrary();
      }
      return value;
    }),
  );

  // 关于页：版本信息与更新生命周期
  ipcMain.handle("eta:update", (_event, action: unknown) =>
    commandReply(async () => {
      if (action === "app-info")
        return { version: app.getVersion(), platform: process.platform, locale: mainI18n.language };
      if (action === "release-page") return shell.openExternal(releaseUrl);
      const currentUpdater = updater();
      if (!currentUpdater)
        throw new LocalizedError("errors:handlers.theUpdateServiceIsNotReadyYet");
      if (action === "state") return currentUpdater.state();
      if (action === "check") return currentUpdater.check();
      if (action === "install") return currentUpdater.install();
      throw new LocalizedError("errors:handlers.invalidUpdateAction");
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
      if (mode !== "choose") throw new LocalizedError("errors:handlers.invalidOpenMethod");
      await chooseAndOpenWithApplication(file);
    }),
  );
  ipcMain.handle("eta:available-editors", () => commandReply(() => detectInstalledEditors()));
  ipcMain.handle("eta:open-external-url", (_event, rawUrl: unknown) =>
    commandReply(async () => {
      if (typeof rawUrl !== "string" || !rawUrl.trim())
        throw new CoreError({ code: "InvalidInput", message: "请求参数无效" });
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        throw new CoreError({ code: "InvalidInput", message: "请求参数无效" });
      }
      if (
        parsed.protocol !== "http:" &&
        parsed.protocol !== "https:" &&
        parsed.protocol !== "mailto:"
      )
        throw new LocalizedError("errors:handlers.invalidExternalUrl");
      await shell.openExternal(parsed.href);
    }),
  );
  ipcMain.handle("eta:open-file-target", (_event, rawInput: unknown) =>
    commandReply(async () => {
      let input: typeof OpenFileTargetSchema.Type;
      try {
        input = decodeOpenFileTarget(rawInput);
      } catch {
        throw new CoreError({ code: "InvalidInput", message: "请求参数无效" });
      }
      const file = await service().resolveWorkspaceFilePath(input.path, input.workspaceId);
      try {
        await stat(file);
      } catch {
        throw new LocalizedError("errors:handlers.fileNotFound");
      }
      switch (input.mode.kind) {
        case "reveal":
          shell.showItemInFolder(file);
          return;
        case "default": {
          const error = await shell.openPath(file);
          if (error) throw new Error(error);
          return;
        }
        case "choose":
          await chooseAndOpenWithApplication(file);
          return;
        case "editor":
          await openFileWithEditor(file, input.mode.editorId, input.line, input.column);
          return;
      }
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
