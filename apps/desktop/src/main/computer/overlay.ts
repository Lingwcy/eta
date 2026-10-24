import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import type { ComputerActivity, ComputerPointer } from "@eta/computer-use/presentation";
import type { ComputerImage, DisplayLayout } from "@eta/computer-use/protocol";
import { t } from "../i18n.ts";
import { computerOverlayDocument } from "./overlay-document.ts";

export type ComputerOverlayState = {
  id: string;
  title: string;
  waiting: string;
  stopLabel: string;
  image?: ComputerImage;
  imageVersion: number;
  windowId?: number;
  bounds?: DisplayLayout["bounds"];
  pointer?: ComputerPointer;
  pointerSequence: number;
};

/** Non-activating presentation windows belong to one native admission, never to a thread ID. */
export function createComputerOverlay(directory: string, stop: (id: string) => Promise<void>) {
  let state: ComputerOverlayState | undefined;
  let preview: BrowserWindow | undefined;
  let cursor: BrowserWindow | undefined;
  let pointerVisible = false;
  let pointerTimer: ReturnType<typeof setTimeout> | undefined;
  let registered = false;
  const owns = (window: BrowserWindow, id: string) =>
    state?.id === id && (window === preview || window === cursor) && !window.isDestroyed();
  const send = (window: BrowserWindow | undefined, image = false) => {
    if (window && state && !window.isDestroyed())
      window.webContents.send("eta:computer-overlay-state", {
        ...state,
        image: image ? state.image : undefined,
      });
  };
  const clear = () => {
    state = undefined;
    pointerVisible = false;
    clearTimeout(pointerTimer);
    const windows = [preview, cursor];
    preview = cursor = undefined;
    for (const window of windows) if (window && !window.isDestroyed()) window.destroy();
    if (registered) {
      ipcMain.removeListener("eta:computer-overlay-ready", ready);
      ipcMain.removeListener("eta:computer-overlay-stop", stopRequest);
      screen.removeListener("display-removed", displayChanged);
      screen.removeListener("display-metrics-changed", displayChanged);
      registered = false;
    }
  };
  const stopOwned = (id: string) => {
    if (state?.id !== id) return;
    clear();
    void stop(id).catch((error) => console.error("Computer overlay cleanup failed", error));
  };
  function ready(event: Electron.IpcMainEvent) {
    for (const window of [preview, cursor]) {
      if (
        window &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame
      )
        send(window, window === preview);
    }
  }
  function stopRequest(event: Electron.IpcMainEvent, id: unknown) {
    if (
      typeof id === "string" &&
      preview &&
      event.sender === preview.webContents &&
      event.senderFrame === preview.webContents.mainFrame
    )
      stopOwned(id);
  }
  function displayChanged() {
    pointerVisible = false;
    cursor?.hide();
    if (preview && !preview.isDestroyed()) {
      const b = preview.getBounds(),
        area = screen.getDisplayMatching(b).workArea;
      preview.setPosition(
        Math.max(area.x, Math.min(b.x, area.x + area.width - b.width)),
        Math.max(area.y, Math.min(b.y, area.y + area.height - b.height)),
        false,
      );
    }
  }
  function create(kind: "preview" | "pointer", id: string) {
    const area = screen.getPrimaryDisplay().workArea;
    const window = new BrowserWindow({
      width: kind === "preview" ? 384 : 72,
      height: kind === "preview" ? 264 : 72,
      ...(kind === "preview"
        ? { x: area.x + area.width - 400, y: area.y + area.height - 280 }
        : {}),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      type: "panel",
      title: "Eta Computer use",
      webPreferences: {
        preload: join(directory, "computer-overlay-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setAlwaysOnTop(true, "floating");
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.setContentProtection(true);
    if (kind === "pointer") window.setIgnoreMouseEvents(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.once("render-process-gone", () => {
      if (owns(window, id)) stopOwned(id);
    });
    window.on("closed", () => {
      if (state?.id === id && (window === preview || window === cursor)) stopOwned(id);
    });
    void window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(computerOverlayDocument(kind))}`)
      .then(
        () => {
          if (!owns(window, id)) return;
          send(window, kind === "preview");
          if (kind === "preview" || pointerVisible) window.showInactive();
        },
        () => {
          if (owns(window, id)) stopOwned(id);
        },
      );
    return window;
  }
  const update = (event: ComputerActivity) => {
    try {
      if (event.type === "start") {
        clear();
        state = {
          id: event.id,
          title: t("native:computerOverlay.active"),
          waiting: t("native:computerOverlay.waiting"),
          stopLabel: t("native:computerOverlay.stop"),
          imageVersion: 0,
          pointerSequence: 0,
        };
        ipcMain.on("eta:computer-overlay-ready", ready);
        ipcMain.on("eta:computer-overlay-stop", stopRequest);
        screen.on("display-removed", displayChanged);
        screen.on("display-metrics-changed", displayChanged);
        registered = true;
        preview = create("preview", event.id);
        return;
      }
      if (!state || state.id !== event.id) return;
      if (event.type === "end") {
        clear();
        return;
      }
      if (event.type === "target") {
        const changed =
          state.windowId !== event.target.windowId ||
          JSON.stringify(state.bounds) !== JSON.stringify(event.target.bounds);
        state = {
          ...state,
          windowId: event.target.windowId,
          bounds: event.target.bounds,
          title: `${t("native:computerOverlay.active")} · ${event.target.windowTitle || event.target.app}`,
          waiting: t("native:computerOverlay.waiting"),
          ...(changed
            ? { image: undefined, imageVersion: state.imageVersion + 1, pointer: undefined }
            : {}),
        };
        if (changed) {
          pointerVisible = false;
          cursor?.hide();
        }
      } else if (event.type === "frame") {
        state = { ...state, image: event.image, imageVersion: state.imageVersion + 1 };
      } else if (event.type === "unavailable") {
        state = {
          ...state,
          image: undefined,
          imageVersion: state.imageVersion + 1,
          waiting: t("native:computerOverlay.unavailable"),
        };
      } else {
        state = { ...state, pointer: event.pointer, pointerSequence: state.pointerSequence + 1 };
        pointerVisible = event.pointer.visible;
        clearTimeout(pointerTimer);
        if (pointerVisible) {
          cursor ??= create("pointer", state.id);
          cursor.setPosition(
            Math.round(event.pointer.point.x - 21),
            Math.round(event.pointer.point.y - 20),
            false,
          );
          send(cursor);
          // First load shows only after the renderer is ready; later updates never activate it.
          if (!cursor.webContents.isLoading()) cursor.showInactive();
          const admitted = state.id,
            window = cursor;
          pointerTimer = setTimeout(() => {
            if (owns(window, admitted)) {
              pointerVisible = false;
              window.hide();
            }
          }, 900);
        } else cursor?.hide();
      }
      send(preview, event.type !== "pointer");
    } catch (error) {
      console.error("Computer overlay unavailable", error);
      stopOwned(event.id);
    }
  };
  return { update, dispose: clear };
}
