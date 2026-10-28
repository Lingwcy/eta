import { app } from "electron";
import type { ComputerActivity } from "@eta/computer-use/presentation";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mainI18n } from "../i18n.ts";
import { createComputerOverlay } from "./overlay.ts";

let started = false;
export function startComputerOverlayHost() {
  if (started) return;
  started = true;
  const data = process.argv
    .find((value) => value.startsWith("--eta-computer-overlay-data="))
    ?.split("=")
    .slice(1)
    .join("=");
  if (!data || !process.send || !process.connected) {
    app.quit();
    return;
  }
  app.setPath("userData", data);
  let overlay: ReturnType<typeof createComputerOverlay> | undefined,
    closed = false;
  let work = Promise.resolve();
  const notify = (message: "ready" | "stop") => {
    if (process.connected) process.send?.(message, () => {});
  };
  process.on("message", (message) => {
    const value = message as { event: ComputerActivity; locale: string };
    work = work
      .then(async () => {
        if (closed || !overlay) return;
        if (mainI18n.language !== value.locale) await mainI18n.changeLanguage(value.locale);
        if (!closed) overlay.update(value.event);
      })
      .catch(() => {
        notify("stop");
      });
  });
  const close = () => {
    closed = true;
    overlay?.dispose();
    app.quit();
  };
  process.once("disconnect", close);
  app.on("window-all-closed", () => {});
  void app.whenReady().then(() => {
    if (closed || !process.connected) {
      close();
      return;
    }
    app.setActivationPolicy("accessory");
    const directory =
      typeof __dirname === "string"
        ? __dirname.replace(/app\.asar(?=[/\\])/, "app.asar.unpacked")
        : dirname(fileURLToPath(import.meta.url));
    overlay = createComputerOverlay(directory, async () => {
      notify("stop");
    });
    notify("ready");
  });
}
if (process.argv.includes("--eta-computer-overlay")) startComputerOverlayHost();
