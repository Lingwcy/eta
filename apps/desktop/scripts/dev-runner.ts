import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const renderer = resolve(root, "apps/desktop/renderer");
const environment = { ...process.env };
const children: ChildProcess[] = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const running = children.filter((child) => child.exitCode === null && child.signalCode === null);
  const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      /* The process may already have exited. */
    }
  };
  for (const child of running) kill(child, "SIGTERM");
  const force = setTimeout(() => {
    for (const child of running) kill(child, "SIGKILL");
  }, 5000);
  void Promise.all(
    running.map((child) => new Promise<void>((resolve) => child.once("close", () => resolve()))),
  ).finally(() => clearTimeout(force));
}

function start(command: string, args: readonly string[], cwd: string, env = environment) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.once("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}

async function waitFor(url: string, server: ChildProcess) {
  for (let attempt = 0; attempt < 150 && !stopping; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(`Vite 开发服务器提前退出：${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.ok && server.exitCode === null && server.signalCode === null) return;
    } catch {
      /* Wait for Vite to bind its development port. */
    }
    await delay(100);
  }
  throw new Error(`页面未就绪：${url}`);
}

async function findAvailablePort() {
  const requested = process.env.ETA_WEB_PORT ? Number(process.env.ETA_WEB_PORT) : undefined;
  if (
    requested !== undefined &&
    (!Number.isInteger(requested) || requested < 1 || requested > 65535)
  )
    throw new Error("ETA_WEB_PORT 必须是 1 到 65535 之间的端口号");

  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`ETA_WEB_PORT ${requested} 已被占用`, { cause: error })
          : error,
      );
    });
    reservation.listen(requested ?? 0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("无法分配 Vite 端口");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop();
  });

try {
  const port = await findAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const vite = start("vp", ["dev"], renderer, { ...environment, ETA_WEB_PORT: String(port) });
  await waitFor(url, vite);
  start(process.execPath, ["scripts/start.mjs"], resolve(root, "apps/desktop"), {
    ...environment,
    ETA_WEB_URL: url,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stop(1);
}
