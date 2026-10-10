import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError, err, ok } from "@eta/agent/env";
import type {
  ExecutionEnv,
  FileErrorCode,
  FileInfo,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLine,
  TextLineReader,
} from "@eta/agent/env";
import { Schema } from "effect";
import type { SandboxPolicy, SandboxStatus } from "../../shared/sandbox.ts";
import { prepareSandboxLaunch } from "./backend.ts";
import type { SandboxLaunch } from "./backend.ts";
import { MessageSchema } from "./protocol.ts";
import type { WorkerMessage, WorkerRequest } from "./protocol.ts";

type Request = Omit<WorkerRequest, "id">;
const expandHome = (path: string) =>
  path === "~"
    ? homedir()
    : path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))
      ? join(homedir(), path.slice(2))
      : path;
class RemoteFileError extends FileError {
  readonly remoteCode: string;
  readonly spillPath?: string;
  constructor(error: NonNullable<WorkerMessage["error"]>) {
    super(error.code as FileErrorCode, error.message, error.path);
    this.remoteCode = error.code;
    this.spillPath = error.spillPath;
  }
}
type Pending = {
  resolve(value: WorkerMessage): void;
  output?: ShellExecOptions["onOutput"];
  context: Context;
  callbackError?: string;
};

export class SandboxedExecutionEnv implements ExecutionEnv {
  readonly id = "node:local";
  get status(): SandboxStatus {
    return this.failure || this.closed
      ? { ...this.launch.status, available: false, reason: this.failure ?? "沙盒执行环境已关闭" }
      : this.launch.status;
  }
  cwd: string;
  private sequence = 0;
  private closed = false;
  private failure?: string;
  private cleanupPromise?: Promise<void>;
  private readonly pending = new Map<number, Pending>();
  private readonly ready: Promise<void>;
  private readonly child: ChildProcess;
  private readonly launch: SandboxLaunch;
  private readonly commandsAllowed: boolean;

  private constructor(child: ChildProcess, launch: SandboxLaunch, commandsAllowed: boolean) {
    this.child = child;
    this.launch = launch;
    this.commandsAllowed = commandsAllowed;
    this.cwd = launch.cwd;
    this.ready = new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        this.fail("沙盒执行进程启动超时");
        reject(new Error("沙盒执行进程启动超时"));
        child.kill();
      }, 10000);
      child.on("message", (raw) => {
        let message: WorkerMessage;
        try {
          message = Schema.decodeUnknownSync(MessageSchema)(raw);
        } catch {
          this.fail("沙盒执行进程返回了无效消息");
          child.kill();
          return;
        }
        if (message.event === "ready") {
          ready = true;
          clearTimeout(timeout);
          resolve();
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (message.event === "output") {
          try {
            pending.output?.(String(message.value), pending.context);
          } catch (error) {
            pending.callbackError = error instanceof Error ? error.message : String(error);
            this.terminate("callback_error", pending.callbackError);
          }
        } else {
          this.pending.delete(message.id);
          pending.resolve(
            pending.callbackError
              ? { ...message, error: { code: "callback_error", message: pending.callbackError } }
              : message,
          );
        }
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
      });
      const failed = (message: string) => {
        clearTimeout(timeout);
        this.fail(message);
        if (!ready) reject(new Error(message));
      };
      child.on("error", (error) => failed(`沙盒执行进程无法启动：${error.message}`));
      child.on("exit", (code, signal) =>
        failed(`沙盒执行进程已退出 (${code ?? signal})${stderr ? `：${stderr.trim()}` : ""}`),
      );
    });
  }

  static async open(
    policy: SandboxPolicy,
    options: { workerPath?: string; runtimeRoots?: readonly string[] } = {},
  ) {
    const source = fileURLToPath(new URL("./worker.ts", import.meta.url));
    const workerPath =
      options.workerPath ??
      (existsSync(source)
        ? source
        : fileURLToPath(new URL("../../sandbox/worker.mjs", import.meta.url)));
    const core = resolve(dirname(source), "../../..");
    const runtimeRoots =
      options.runtimeRoots ??
      (workerPath.endsWith(".ts")
        ? [
            join(core, "src"),
            join(core, "package.json"),
            join(core, "node_modules"),
            join(core, "../../node_modules"),
            join(core, "../agent/src"),
            join(core, "../agent/package.json"),
          ]
        : []);
    const launch = await prepareSandboxLaunch(policy, workerPath, runtimeRoots);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const env = new SandboxedExecutionEnv(
      child,
      launch,
      policy.mode !== "read-only" || policy.commandAccess === true,
    );
    try {
      await env.ready;
      if (child.pid === undefined) throw new Error("沙盒执行进程没有有效身份");
      await launch.verify?.(child.pid);
      return env;
    } catch (error) {
      await env.cleanup(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  private fail(message: string, code = "unknown") {
    this.failure = message;
    for (const [id, pending] of this.pending)
      pending.resolve({ id, event: "result", error: { code, message } });
    this.pending.clear();
  }

  private terminate(code: string, message: string) {
    if (this.closed) return;
    this.closed = true;
    this.fail(message, code);
    if (this.child.pid) {
      try {
        process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    }
  }

  private async request<T>(
    request: Request,
    context: Context,
    output?: ShellExecOptions["onOutput"],
  ): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "aborted", request.path));
    if (this.closed || this.failure)
      return err(new FileError("unknown", this.failure ?? "沙盒执行环境已关闭"));
    const id = ++this.sequence;
    const abort = () => {
      if (request.method === "exec") this.terminate("aborted", "Command aborted");
      else if (this.child.connected) this.child.send({ id, method: "cancel" });
    };
    context.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const message = await new Promise<WorkerMessage>((resolve) => {
        this.pending.set(id, { resolve, context, output });
        this.child.send(
          {
            ...request,
            id,
            ...(request.path && request.method !== "exec"
              ? { path: expandHome(request.path) }
              : {}),
            ...(request.destination ? { destination: expandHome(request.destination) } : {}),
            ...(request.options?.cwd
              ? { options: { ...request.options, cwd: expandHome(request.options.cwd) } }
              : {}),
          },
          (error) => {
            if (error) {
              this.pending.delete(id);
              resolve({ id, event: "result", error: { code: "unknown", message: error.message } });
            }
          },
        );
      });
      return message.error ? err(new RemoteFileError(message.error)) : ok(message.value as T);
    } finally {
      context.abortSignal?.removeEventListener("abort", abort);
    }
  }

  absolutePath(path: string, context: Context) {
    return this.request<string>({ method: "absolutePath", path }, context);
  }
  joinPath(parts: string[], context: Context) {
    return this.request<string>({ method: "joinPath", parts }, context);
  }
  readTextFile(path: string, context: Context) {
    return this.request<string>({ method: "readTextFile", path }, context);
  }
  async openTextLineReader(
    path: string,
    context: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    const result = await this.request<number>({ method: "openTextLineReader", path }, context);
    if (!result.ok) return result;
    const reader = result.value;
    return ok({
      readLine: (context) =>
        this.request<TextLine | undefined>({ method: "readLine", reader }, context),
      close: async (context) => {
        await this.request({ method: "closeReader", reader }, context);
      },
    });
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.request<string[]>({ method: "readTextLines", path, options }, context);
  }
  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const result = await this.request<string>({ method: "readBinaryFile", path }, context);
    return result.ok ? ok(Buffer.from(result.value, "base64")) : result;
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.request<void>(
      {
        method: "writeFile",
        path,
        content: typeof content === "string" ? content : Buffer.from(content).toString("base64"),
        binary: typeof content !== "string",
      },
      context,
    );
  }
  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.request<void>(
      {
        method: "appendFile",
        path,
        content: typeof content === "string" ? content : Buffer.from(content).toString("base64"),
        binary: typeof content !== "string",
      },
      context,
    );
  }
  truncateFile(path: string, size: number, context: Context) {
    return this.request<void>({ method: "truncateFile", path, size }, context);
  }
  flushFile(path: string, context: Context) {
    return this.request<void>({ method: "flushFile", path }, context);
  }
  renameFile(path: string, destination: string, context: Context) {
    return this.request<void>({ method: "renameFile", path, destination }, context);
  }
  fileInfo(path: string, context: Context) {
    return this.request<FileInfo>({ method: "fileInfo", path }, context);
  }
  listDir(path: string, context: Context) {
    return this.request<FileInfo[]>({ method: "listDir", path }, context);
  }
  canonicalPath(path: string, context: Context) {
    return this.request<string>({ method: "canonicalPath", path }, context);
  }
  exists(path: string, context: Context) {
    return this.request<boolean>({ method: "exists", path }, context);
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.request<void>({ method: "createDir", path, options }, context);
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ) {
    return this.request<void>({ method: "remove", path, options }, context);
  }
  createTempDir(prefix: string | undefined, context: Context) {
    return this.request<string>({ method: "createTempDir", options: { prefix } }, context);
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.request<string>({ method: "createTempFile", options }, context);
  }
  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    if (!this.commandsAllowed)
      return err(new ExecutionError("spawn_error", "只读模式下运行命令需要批准"));
    const seconds = options?.timeout;
    if (
      seconds !== undefined &&
      (!Number.isFinite(seconds) || seconds <= 0 || seconds > 2147483647 / 1000)
    )
      return err(new ExecutionError("timeout", "Invalid timeout"));
    const timeout =
      seconds === undefined
        ? undefined
        : setTimeout(
            () => this.terminate("timeout", `Command timed out after ${seconds} seconds`),
            seconds * 1000,
          );
    let result: Result<ShellExecResult, FileError>;
    try {
      result = await this.request<ShellExecResult>(
        { method: "exec", path: command, options },
        context,
        options?.onOutput,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.closed) await this.cleanup(context);
    }
    if (result.ok) return result;
    const code =
      result.error instanceof RemoteFileError ? result.error.remoteCode : result.error.code;
    const error = new ExecutionError(
      code === "aborted" ||
        code === "timeout" ||
        code === "shell_unavailable" ||
        code === "callback_error"
        ? code
        : "spawn_error",
      result.error.message,
      result.error,
    );
    if (result.error instanceof RemoteFileError) error.spillPath = result.error.spillPath;
    return err(error);
  }
  async cleanup(_context: Context) {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.terminate("aborted", "沙盒执行环境已关闭");
    this.cleanupPromise = this.launch.cleanup();
    return this.cleanupPromise;
  }
}
