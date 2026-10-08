import type { AppUpdater } from "electron-updater";
import type { UpdateState } from "../../bridge.ts";

export const releaseUrl = "https://github.com/XiaoMouz/eta/releases/latest";
const startupDelay = 10_000;
const checkInterval = 4 * 60 * 60 * 1000;

type Backend = Pick<
  AppUpdater,
  "autoDownload" | "autoInstallOnAppQuit" | "on" | "checkForUpdates" | "quitAndInstall"
>;

/**
 * Owns the single update lifecycle for the app. `backend` is electron-updater's `autoUpdater`;
 * pass `undefined` for unpackaged builds, which have no app-update.yml to read.
 */
export function createUpdater(options: {
  backend: Backend | undefined;
  autoCheck: boolean;
  broadcast: (state: UpdateState) => void;
}) {
  const { backend, broadcast } = options;
  let state: UpdateState = backend ? { status: "idle" } : { status: "unsupported" };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let scheduled = false;
  const set = (next: UpdateState) => {
    state = next;
    broadcast(next);
  };
  // A finished download stays ready to install; later background checks must not hide it.
  const settled = () => state.status === "downloaded";

  if (backend) {
    backend.autoDownload = true;
    backend.autoInstallOnAppQuit = true;
    backend.on("checking-for-update", () => {
      if (!settled()) set({ status: "checking" });
    });
    backend.on("update-not-available", () => {
      if (!settled()) set({ status: "not-available" });
    });
    backend.on("update-available", (info) => {
      if (!settled()) set({ status: "available", version: info.version });
    });
    backend.on("download-progress", (progress) => {
      if (settled()) return;
      const percent = Math.floor(progress.percent);
      // Progress fires many times per second; repaint only when the visible number changes.
      if (state.status === "downloading" && state.percent === percent) return;
      const version = "version" in state ? state.version : "";
      set({ status: "downloading", version, percent });
    });
    backend.on("update-downloaded", (info) => {
      set({ status: "downloaded", version: info.version });
    });
    backend.on("error", (error) => {
      if (!settled()) set({ status: "error", message: describe(error), releaseUrl });
    });
  }

  const busy = () =>
    state.status === "checking" || state.status === "available" || state.status === "downloading";
  const check = async () => {
    if (!backend || busy() || settled()) return state;
    // Failures also arrive through the "error" event, which owns the visible state.
    await backend.checkForUpdates().catch(() => undefined);
    return state;
  };
  const schedule = (enabled: boolean) => {
    // Unrelated settings saves call this too; keep the running cadence when nothing changed.
    if (enabled === scheduled) return;
    scheduled = enabled;
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    startupTimer = intervalTimer = undefined;
    if (!enabled) return;
    startupTimer = setTimeout(() => void check(), startupDelay);
    intervalTimer = setInterval(() => void check(), checkInterval);
  };
  schedule(Boolean(backend) && options.autoCheck);

  return {
    state: () => state,
    check,
    install() {
      if (!backend || state.status !== "downloaded") throw new Error("没有可安装的更新");
      backend.quitAndInstall();
    },
    setAutoCheck: (enabled: boolean) => schedule(Boolean(backend) && enabled),
    dispose: () => schedule(false),
  };
}
export type Updater = ReturnType<typeof createUpdater>;

function describe(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // electron-updater appends HTTP headers and stack-like detail after the first line.
  return `检查更新失败：${message.split("\n")[0]}`;
}
