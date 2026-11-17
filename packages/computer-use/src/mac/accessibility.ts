import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Schema } from "effect";
import type { ComputerPointer } from "../presentation.ts";
import { ComputerError } from "../protocol.ts";
import type {
  ComputerAccessibility,
  ComputerTarget,
  ComputerCondition,
  CaptureLimits,
  ComputerCapture,
} from "../protocol.ts";

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    ok: Schema.Literal(false),
    message: Schema.String,
    applied: Schema.Literals(["no", "yes", "unknown"]),
    reason: Schema.optionalKey(Schema.Literals(["user_interrupted", "stale_frame"])),
  }),
]);
const Application = Schema.Struct({
  app: Schema.String.check(Schema.isPattern(/^pid:[1-9][0-9]*$/)),
});
const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const Bounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
const Layout = Schema.Struct({ id: Schema.String, revision: Schema.String, bounds: Bounds });
const Observation = Schema.Struct({
  scope: Schema.Literals(["window", "region", "menu_bar"]),
  projection: Schema.Literals(["full", "compact", "overview"]),
  complete: Schema.Boolean,
  exhaustive: Schema.Boolean,
  boundaries: Schema.Array(
    Schema.Struct({
      index: Schema.Number,
      reason: Schema.String,
      omittedChildren: Schema.optionalKey(Schema.Number),
    }),
  ),
  unknown: Schema.Array(
    Schema.Struct({ index: Schema.Number, fields: Schema.Array(Schema.String) }),
  ),
  visitedNodes: Schema.Number,
  axReads: Schema.Number,
  fallback: Schema.optionalKey(Schema.Literals(["root_unavailable", "menu_opened"])),
});
const State = Schema.Struct({
  id: Schema.String,
  app: Schema.String,
  windowTitle: Schema.String,
  text: Schema.String,
  windowId: Schema.optionalKey(Schema.Number),
  bounds: Schema.optionalKey(Bounds),
  cursor: Schema.optionalKey(Schema.NullOr(Point)),
  observation: Schema.optionalKey(Observation),
});
const WaitEvidence = Schema.Literals(["satisfied", "unsatisfied", "unknown", "ambiguous"]);
const WaitReply = Schema.Struct({
  outcome: Schema.Struct({
    status: Schema.Literals(["satisfied", "timeout", "unconfirmed", "ambiguous", "target_closed"]),
    last: WaitEvidence,
    lastKnown: Schema.optionalKey(WaitEvidence),
    final: Schema.optionalKey(WaitEvidence),
    reason: Schema.optionalKey(Schema.String),
    samples: Schema.Number,
    probeReads: Schema.Number,
  }),
  state: Schema.optionalKey(State),
});
const StateReceipt = Schema.Union([
  Schema.Struct({
    applied: Schema.Literal("no"),
    verification: Schema.Struct({
      status: Schema.Literal("satisfied"),
      noOp: Schema.Literal(true),
    }),
  }),
  Schema.Struct({
    applied: Schema.Literal("yes"),
    verification: Schema.Struct({
      status: Schema.Literals(["satisfied", "unsatisfied", "unknown"]),
      reason: Schema.optionalKey(Schema.String),
    }),
  }),
]);

function accessibilityState({
  cursor,
  observation,
  ...state
}: typeof State.Type): ComputerAccessibility {
  return {
    ...state,
    ...(cursor ? { cursor } : {}),
    ...(observation
      ? {
          observation: {
            ...observation,
            boundaries: observation.boundaries.map((item) => ({ ...item })),
            unknown: observation.unknown.map((item) => ({ ...item, fields: [...item.fields] })),
          },
        }
      : {}),
  };
}
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
    openApplication: async (app: string, signal: AbortSignal) =>
      Schema.decodeUnknownSync(Application)(await request({ operation: "open", app }, signal)),
    observe: async (
      target: ComputerTarget,
      signal: AbortSignal,
    ): Promise<ComputerAccessibility> => {
      const state = Schema.decodeUnknownSync(State)(
        await request(
          { operation: "observe", ...target, presentation: Boolean(onPointer) },
          signal,
        ),
      );
      if ((target.projection || target.rootIndex !== undefined) && !state.observation)
        throw new ComputerError(
          "observation_failed",
          "当前原生 helper 不支持分层观察；请重新构建并重启 Eta",
        );
      return accessibilityState(state);
    },
    waitUntil: async (
      state: ComputerAccessibility,
      condition: ComputerCondition,
      timeoutMs: number,
      signal: AbortSignal,
    ) => {
      const reply = Schema.decodeUnknownSync(WaitReply)(
        await request(
          {
            operation: "wait_until",
            id: state.id,
            app: state.app,
            projection: state.observation?.projection,
            condition,
            timeoutMs,
          },
          signal,
        ),
      );
      return { outcome: reply.outcome, state: reply.state && accessibilityState(reply.state) };
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
    ) => {
      const result = await request(
        { ...input, id: state.id, operation, expectedBounds: state.bounds },
        signal,
      );
      if (operation === "set_checked" || operation === "set_expanded" || operation === "select")
        return Schema.decodeUnknownSync(StateReceipt)(result);
    },
    reset,
    assertHealthy,
  };
}
