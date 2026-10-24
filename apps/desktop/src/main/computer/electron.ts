import { app, desktopCapturer, systemPreferences, shell } from "electron";
import { release } from "node:os";
import { join } from "node:path";
import { ComputerService } from "@eta/computer-use/service";
import { createMacComputerAdapter } from "@eta/computer-use/mac/adapter";
import type { DesktopComputer } from "./capability.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants } from "node:fs";
import { createComputerOverlayProcess } from "./overlay-process.ts";
import { createAccessibilityBridge } from "@eta/computer-use/mac/accessibility";

/** Settings grant access; unsupported platforms never load the native macOS module. */
export function createElectronComputer(): DesktopComputer | undefined {
  if (process.platform !== "darwin") return undefined;
  const directory =
    typeof __dirname === "string"
      ? __dirname.replace(/app\.asar(?=[/\\])/, "app.asar.unpacked")
      : join(app.getAppPath(), "dist", "electron");
  const accessibilityBinary = join(directory, "computer-native", "eta-accessibility");
  let overlay: ReturnType<typeof createComputerOverlayProcess> | undefined;
  const adapter = createMacComputerAdapter({
    permissions: () => ({
      screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    }),
    openApplication: openMacApplication,
    accessibility: createAccessibilityBridge(
      accessibilityBinary,
      (event) => service.presentPointer(event),
      () => overlay?.pid(),
    ),
  });
  const service = new ComputerService(adapter, (event) => {
    overlay ??= createComputerOverlayProcess(directory, (id) => service.stopPresentation(id));
    overlay.update(event);
  });
  return {
    service,
    enabled: () => true,
    status: () => {
      if (Number(release().split(".")[0]) < 23)
        return { status: "unavailable", message: "Computer use 需要 macOS 14 或更新版本" };
      try {
        accessSync(accessibilityBinary, constants.X_OK);
      } catch (error) {
        return {
          status: "unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const screen = systemPreferences.getMediaAccessStatus("screen") === "granted";
      const accessibility = systemPreferences.isTrustedAccessibilityClient(false);
      return { status: screen && accessibility ? "ready" : "permissions", screen, accessibility };
    },
    openPermissions: async (permission) => {
      if (permission === "accessibility") systemPreferences.isTrustedAccessibilityClient(true);
      else if (systemPreferences.getMediaAccessStatus("screen") !== "granted") {
        // An explicit grant request registers first-time installs with macOS, without capturing pixels.
        await desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
          .catch(() => {});
      }
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${permission === "screen" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"}`,
      );
    },
  };
}

export async function openMacApplication(name: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const bundleIdentifier = !name.endsWith(".app") && /^[\w-]+(?:\.[\w-]+)+$/.test(name);
  await promisify(execFile)("/usr/bin/open", ["-g", bundleIdentifier ? "-b" : "-a", name], {
    signal,
    timeout: 15000,
  });
  signal.throwIfAborted();
}
