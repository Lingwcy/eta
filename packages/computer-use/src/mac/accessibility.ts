import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Schema } from "effect";
import type { ComputerPointer } from "../presentation.ts";
import { ComputerError } from "../protocol.ts";
import type {
  ComputerAccessibility,
  ComputerTarget,
  CaptureLimits,
  ComputerCapture,
} from "../protocol.ts";

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
    applied: Schema.Literals(["no", "yes", "unknown"]),
    reason: Schema.optionalKey(Schema.Literal("user_interrupted")),
  }),
]);
const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const Bounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const Layout = Schema.Struct({ id: Schema.String, revision: Schema.String, bounds: Bounds });
const State = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  windowTitle: Schema.String,
  text: Schema.String,
  windowId: Schema.optionalKey(Schema.Number),
  bounds: Schema.optionalKey(Bounds),
  cursor: Schema.optionalKey(Schema.NullOr(Point)),
});
const Pointer = Schema.Struct({
  event: Schema.Literal("pointer"),
  snapshot: Schema.String,
  windowId: Schema.Number,
  point: Point,
  bounds: Bounds,
  phase: Schema.Literals(["move", "down", "up"]),
  visible: Schema.Boolean,
});
const Capture = Schema.Struct({
  layout: Layout,
  excludesChildWindows: Schema.optionalKey(Schema.Boolean),
  width: Schema.Number,
  height: Schema.Number,
  image: Schema.Struct({
    type: Schema.Literal("image"),
    data: Schema.String,
    mimeType: Schema.String,
  }),
});

/** A single native process retains opaque AX handles. Killing it invalidates every old index. */
export function createAccessibilityBridge(
  binary: string,
  onPointer?: (event: ComputerPointer) => void,
  presentationPID?: () => number | undefined,
) {
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: { resolve(value: unknown): void; reject(error: unknown): void } | undefined;
  let buffer = "";
  let diagnostic = "";
  let stopping: Promise<void> | undefined;
  let cleanupFailure: ComputerError | undefined;
  const assertHealthy = () => {
    if (cleanupFailure) throw cleanupFailure;
  };
  const reset = async () => {
    if (stopping) return stopping;
    const retiring = child;
    if (!retiring) return;
    stopping = new Promise<void>((resolve, reject) => {
      let forced = false;
      const deadline = setTimeout(() => {
        forced = true;
        retiring.kill("SIGKILL");
      }, 3000);
      deadline.unref();
      retiring.once("close", (code, signal) => {
        clearTimeout(deadline);
        if (forced || (code !== null && code !== 0) || (signal !== null && signal !== "SIGTERM")) {
          cleanupFailure = new ComputerError(
            "input_failed",
            "原生进程未能完成输入清理；请重启 Eta 后再使用桌面控制",
            "unknown",
          );
          reject(cleanupFailure);
        } else resolve();
      });
      retiring.stdin.end();
      retiring.kill("SIGTERM");
    }).finally(() => {
      stopping = undefined;
    });
    return stopping;
  };
  const start = () => {
    assertHealthy();
    if (child) return child;
    const current = spawn(binary, [], { stdio: "pipe" });
    child = current;
    buffer = "";
    diagnostic = "";
    current.stderr.setEncoding("utf8");
    current.stderr.on("data", (data: string) => {
      diagnostic = (diagnostic + data).slice(-2048);
    });
    current.stdout.setEncoding("utf8");
    current.stdout.on("data", (data: string) => {
      if (child !== current) return;
      buffer += data;
      if (buffer.length > 4_500_000) {
        pending?.reject(new Error("桌面观察返回内容过大"));
        pending = undefined;
        void reset().catch(() => {});
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          pending?.reject(new Error("Invalid native JSON"));
          pending = undefined;
          void reset().catch(() => {});
          return;
        }
        if (typeof parsed === "object" && parsed !== null && "event" in parsed) {
          try {
            const { event: _event, ...pointer } = Schema.decodeUnknownSync(Pointer)(parsed);
            onPointer?.(pointer);
          } catch {
            /* Malformed telemetry cannot complete an input request. */
          }
          continue;
        }
        const request = pending;
        pending = undefined;
        if (!request) continue;
        try {
          const reply = Schema.decodeUnknownSync(Reply)(parsed);
          if (!reply.ok)
            request.reject(
              new ComputerError(reply.reason ?? "input_failed", reply.message, reply.applied),
            );
          else request.resolve(reply.result);
        } catch (error) {
          request.reject(error);
          void reset().catch(() => {});
        }
      }
    });
    current.once("error", (error) => {
      pending?.reject(error);
      pending = undefined;
    });
    current.once("close", (code, signal) => {
      if (child !== current) return;
      if (!stopping && (pending || code !== 0 || signal !== null))
        cleanupFailure = new ComputerError(
          "input_failed",
          "原生进程意外退出，无法确认输入清理；请重启 Eta",
          "unknown",
        );
      child = undefined;
      pending?.reject(
        new ComputerError("input_failed", `辅助功能进程已退出 ${diagnostic}`, "unknown"),
      );
      pending = undefined;
    });
    return current;
  };
  const request = async (args: object, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (pending || stopping) throw new ComputerError("busy", "辅助功能正在执行另一操作");
    const current = start();
    let aborted: Promise<void> | undefined;
    const abort = () => {
      aborted = reset();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const owner = { resolve, reject };
        pending = owner;
        current.stdin.write(
          `${JSON.stringify({ ...args, presentationPID: presentationPID?.() })}\n`,
          (error) => {
            if (error && pending === owner) {
              owner.reject(error);
              pending = undefined;
              void reset().catch(() => {});
            }
          },
        );
      });
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      await aborted;
    }
  };
  return {
    checkOwnership: async (signal: AbortSignal, existingOnly = false) => {
      if (existingOnly && (!child || stopping)) return;
      await request({ operation: "check_ownership" }, signal);
    },
    observe: async (
      target: ComputerTarget,
      signal: AbortSignal,
    ): Promise<ComputerAccessibility> => {
      const { cursor, ...state } = Schema.decodeUnknownSync(State)(
        await request(
          { operation: "observe", ...target, presentation: Boolean(onPointer) },
          signal,
        ),
      );
      return { ...state, ...(cursor ? { cursor } : {}) };
    },
    layout: async (state: ComputerAccessibility, signal: AbortSignal) =>
      Schema.decodeUnknownSync(Layout)(
        await request({ operation: "layout", id: state.id }, signal),
      ),
    capture: async (
      state: ComputerAccessibility,
      signal: AbortSignal,
      limits?: CaptureLimits,
    ): Promise<ComputerCapture> =>
      Schema.decodeUnknownSync(Capture)(
        await request({ operation: "capture", id: state.id, limits }, signal),
      ),
    execute: async (
      state: ComputerAccessibility,
      operation: string,
      input: object,
      signal: AbortSignal,
    ) => request({ ...input, id: state.id, operation, expectedBounds: state.bounds }, signal),
    reset,
    assertHealthy,
  };
}
