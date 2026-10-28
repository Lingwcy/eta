import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import type { BotLog } from "./log.ts";

type Operation = "thread.read" | "thread.operation" | "thread.subscribe" | "workspace.git";
type Phase = "scope" | "authorize" | "open" | "encode" | "subscribe" | "git";

let nextRequest = 0;

/** Sample slow handlers once while pending and once at settlement, without retaining their data. */
export async function diagnoseRequest<T>(
  log: BotLog | undefined,
  operation: Operation,
  work: (phase: (value: Phase) => void) => Promise<T>,
): Promise<T> {
  if (!log) return work(() => {});
  const request = ++nextRequest;
  const started = performance.now();
  const cpu = process.cpuUsage();
  const loop = performance.eventLoopUtilization();
  let phase: Phase = "scope";
  let slow = false;
  const report = (outcome: "pending" | "completed" | "failed") => {
    try {
      const memory = process.memoryUsage();
      const usage = process.cpuUsage(cpu);
      log({
        event: "http.slow",
        operation,
        request,
        phase,
        outcome,
        elapsedMs: Math.round(performance.now() - started),
        // Resource deltas describe the whole process during this request, not its own CPU cost.
        cpuMicros: usage.user + usage.system,
        eventLoopUtilization: performance.eventLoopUtilization(loop).utilization,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
      });
    } catch {
      // A diagnostic sink must not change an admitted request's outcome.
    }
  };
  const timer = setTimeout(() => {
    slow = true;
    report("pending");
  }, 5000);
  timer.unref();
  try {
    const result = await work((value) => {
      phase = value;
    });
    if (slow || performance.now() - started >= 5000) report("completed");
    return result;
  } catch (error) {
    if (slow || performance.now() - started >= 5000) report("failed");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
