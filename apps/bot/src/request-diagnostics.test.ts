import { afterEach, expect, test, vi } from "vite-plus/test";
import { diagnoseRequest } from "./request-diagnostics.ts";
import type { BotEvent } from "./log.ts";

afterEach(() => vi.useRealTimers());

test.each(["completed", "failed"] as const)(
  "a stalled request reports its current phase once and retains its %s outcome",
  async (outcome) => {
    vi.useFakeTimers();
    const log = vi.fn<(event: BotEvent) => void>();
    const release = Promise.withResolvers<string>();
    const failure = new Error("private payload and credentials");
    const pending = diagnoseRequest(log, "thread.read", async (phase) => {
      phase("open");
      await release.promise;
      phase("encode");
      if (outcome === "failed") throw failure;
      return "private response";
    });
    const result =
      outcome === "failed"
        ? expect(pending).rejects.toBe(failure)
        : expect(pending).resolves.toBe("private response");
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatchObject({
        event: "http.slow",
        operation: "thread.read",
        phase: "open",
        outcome: "pending",
        elapsedMs: expect.any(Number),
        heapLimitBytes: expect.any(Number),
        cpuMicros: expect.any(Number),
      });
      await vi.advanceTimersByTimeAsync(60000);
      expect(log).toHaveBeenCalledTimes(1);
      release.resolve("release");
      await result;
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[1]![0]).toMatchObject({
        request: log.mock.calls[0]![0].request,
        phase: "encode",
        outcome,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve("release");
      await pending.catch(() => {});
    }
  },
);

test("fast reads stay quiet and a diagnostic sink cannot break a slow request", async () => {
  vi.useFakeTimers();
  const log = vi.fn(() => {
    throw new Error("log failed");
  });
  await expect(diagnoseRequest(log, "workspace.git", async () => "ready")).resolves.toBe("ready");
  expect(log).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const release = Promise.withResolvers<string>();
  const pending = diagnoseRequest(log, "workspace.git", () => release.promise);
  try {
    await vi.advanceTimersByTimeAsync(5000);
    release.resolve("ready");
    await expect(pending).resolves.toBe("ready");
    expect(log).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve("ready");
    await pending;
  }
});
