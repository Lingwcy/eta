import { WebContentsView } from "electron";
import type { BrowserWindow } from "electron";
import { Schema } from "effect";
import { browserAddress, desktopShortcut } from "../../browser/protocol.ts";
import type { BrowserCommand, BrowserEvent, BrowserState } from "../../browser/protocol.ts";
import { BrowserManager } from "./manager.ts";
import { DesktopServiceError } from "../service/errors.ts";

const Id = Schema.NonEmptyString;
const CommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["create", "navigate"]), id: Id, url: Id }),
  Schema.Struct({
    type: Schema.Literals(["back", "forward", "reload", "stop", "close", "capture", "hide"]),
    id: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("show"),
    id: Id,
    bounds: Schema.Struct({
      x: Schema.Int,
      y: Schema.Int,
      width: Schema.Int.check(Schema.isGreaterThan(0)),
      height: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  }),
]);

export function decodeBrowserCommand(raw: unknown): BrowserCommand {
  try {
    return Schema.decodeUnknownSync(CommandSchema, { onExcessProperty: "error" })(raw);
  } catch {
    throw new DesktopServiceError({ code: "InvalidInput", message: "浏览器请求参数无效" });
  }
}

/** Guest pages never receive Eta's preload, credentials, or agent bridge. */
export function createWindowBrowser(window: BrowserWindow) {
  const emit = (event: BrowserEvent) => {
    if (!window.webContents.isDestroyed()) window.webContents.send("browser:event", event);
  };
  const manager = new BrowserManager((id, changed) => {
    const view = new WebContentsView({
      webPreferences: {
        partition: "persist:eta-browser",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const contents = view.webContents;
    window.contentView.addChildView(view);
    let url = "";
    let title = "新标签页";
    let favicon: string | undefined;
    let loading = false;
    let error: string | undefined;
    const state = (): BrowserState => ({
      id,
      url,
      title,
      favicon,
      loading,
      error,
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
    });
    const navigate = (value: string) => {
      url = value;
      error = undefined;
      changed();
    };
    contents.on("did-start-loading", () => {
      loading = true;
      changed();
    });
    contents.on("did-stop-loading", () => {
      loading = false;
      changed();
    });
    contents.on("did-navigate", (_event, value) => navigate(value));
    contents.on("did-navigate-in-page", (_event, value, isMainFrame) => {
      if (isMainFrame) navigate(value);
    });
    contents.on("page-title-updated", (_event, value) => {
      title = value;
      changed();
    });
    contents.on("page-favicon-updated", (_event, values) => {
      favicon = values.find((value) => /^https?:\/\//i.test(value));
      changed();
    });
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      loading = false;
      error = "网页暂时无法打开，请检查网址或重试";
      changed();
    });
    contents.on("render-process-gone", () => {
      loading = false;
      error = "网页已停止响应，请刷新重试";
      changed();
    });
    contents.on("will-navigate", (event, value) => {
      if (!/^https?:\/\//i.test(value)) event.preventDefault();
    });
    contents.on("will-redirect", (event, value) => {
      if (!/^https?:\/\//i.test(value)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url: value }) => {
      if (/^https?:\/\//i.test(value)) emit({ type: "open", url: browserAddress(value) });
      return { action: "deny" };
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const action = desktopShortcut(input);
      if (action) {
        event.preventDefault();
        window.webContents.focus();
        emit({ type: "shortcut", action });
      }
    });
    return {
      state,
      load: async (value) => {
        url = value;
        title = new URL(value).hostname;
        favicon = undefined;
        error = undefined;
        loading = true;
        changed();
        await contents.loadURL(value);
      },
      back: () => contents.navigationHistory.goBack(),
      forward: () => contents.navigationHistory.goForward(),
      reload: () => {
        error = undefined;
        contents.reload();
      },
      stop: () => contents.stop(),
      bounds: (bounds) => {
        const frame = window.getContentBounds();
        const x = Math.max(0, Math.min(bounds.x, frame.width - 1));
        const y = Math.max(0, Math.min(bounds.y, frame.height - 1));
        view.setBounds({
          x,
          y,
          width: Math.max(1, Math.min(bounds.width, frame.width - x)),
          height: Math.max(1, Math.min(bounds.height, frame.height - y)),
        });
      },
      visible: (visible) => view.setVisible(visible),
      capture: async () => {
        if (contents.isDestroyed()) return;
        const image = await contents.capturePage(undefined, { stayHidden: true });
        if (image.isEmpty()) return;
        return image.resize({ width: 960 }).toDataURL();
      },
      close: () => {
        if (!window.isDestroyed()) window.contentView.removeChildView(view);
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      },
    };
  }, emit);
  return manager;
}
