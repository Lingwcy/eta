import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerActivity } from "@eta/computer-use/presentation";
import { mainI18n } from "../i18n.ts";

/** An accessory process owns presentation so Space policy never transforms the main app. */
export function createComputerOverlayProcess(
  directory: string,
  stop: (id: string) => Promise<void>,
) {
  type Child = ReturnType<typeof spawn>;
  let current:
    | {
        id: string;
        child: Child;
        ready: boolean;
        queued: ComputerActivity[];
        send(event: ComputerActivity): void;
      }
    | undefined;
  const retire = () => {
    const previous = current;
    current = undefined;
    if (!previous) return;
    if (previous.child.connected) previous.child.disconnect();
    if (previous.child.exitCode !== null || previous.child.signalCode !== null) return;
    const deadline = setTimeout(() => previous.child.kill("SIGTERM"), 2000);
    deadline.unref();
    previous.child.once("exit", () => clearTimeout(deadline));
  };
  const update = (event: ComputerActivity) => {
    if (event.type === "end") {
      if (current?.id === event.id) retire();
      return;
    }
    if (event.type === "start") {
      retire();
      const data = mkdtempSync(join(tmpdir(), "eta-computer-overlay-"));
      const child = spawn(
        process.execPath,
        [
          ...(process.defaultApp ? [join(directory, "computer-overlay-host.cjs")] : []),
          "--eta-computer-overlay",
          `--eta-computer-overlay-data=${data}`,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      const admission = {
        id: event.id,
        child,
        ready: false,
        queued: [] as ComputerActivity[],
        send(activity: ComputerActivity) {
          if (current !== admission || !child.connected) return;
          child.send({ event: activity, locale: mainI18n.language }, (error) => {
            if (error) fail();
          });
        },
      };
      current = admission;
      const fail = () => {
        if (current === admission) {
          retire();
          void stop(admission.id).catch((error) =>
            console.error("Computer presentation cleanup failed", error),
          );
        }
      };
      const startup = setTimeout(fail, 8000);
      startup.unref();
      child.once("exit", () => clearTimeout(startup));
      child.on("message", (message) => {
        if (current !== admission) return;
        if (message === "ready") {
          clearTimeout(startup);
          admission.ready = true;
          for (const activity of admission.queued.splice(0)) admission.send(activity);
        } else if (message === "stop") fail();
      });
      child.on("error", () => {
        clearTimeout(startup);
        fail();
        void rm(data, { recursive: true, force: true }).catch(() => {});
      });
      child.once("exit", () => {
        // Electron descendants may inherit stderr after the GUI process has exited.
        // Observe its actual exit and release our pipe instead of awaiting their handles.
        child.stderr?.destroy();
        fail();
        void rm(data, { recursive: true, force: true }).catch(() => {});
      });
      child.stderr?.on("data", (chunk) =>
        console.error("Computer presentation:", String(chunk).slice(-1000)),
      );
      admission.queued.push(event);
      return;
    }
    const admission = current;
    if (!admission || admission.id !== event.id) return;
    if (admission.ready) admission.send(event);
    else {
      // Bound startup buffering: keep the latest frame/pointer, retaining start/target order.
      admission.queued = admission.queued.filter(
        (previous) =>
          previous.type !== event.type && (event.type !== "target" || previous.type === "start"),
      );
      admission.queued.push(event);
    }
  };
  return { update, dispose: retire, pid: () => current?.child.pid };
}
