/** A visible tray is required before Windows can remain alive after the last window closes. */
export function createBackgroundResidence(options: {
  platform: string;
  createTray(open: () => void, quit: () => void): { destroy(): void; refresh?(): void };
  open(this: void): void;
  quit(this: void): void;
  windowCount(): number;
}) {
  let tray: ReturnType<typeof options.createTray> | undefined;
  let disposed = false;
  return {
    configure(enabled: boolean) {
      if (disposed || options.platform !== "win32") return;
      if (enabled && !tray) tray = options.createTray(options.open, options.quit);
      if (!enabled && tray) {
        tray.destroy();
        tray = undefined;
        if (!options.windowCount()) options.quit();
      }
    },
    keepRunning() {
      return (
        !disposed && (options.platform === "darwin" || (options.platform === "win32" && !!tray))
      );
    },
    refresh() {
      if (!disposed) tray?.refresh?.();
    },
    dispose() {
      disposed = true;
      tray?.destroy();
      tray = undefined;
    },
  };
}
