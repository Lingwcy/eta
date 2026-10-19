import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";
import { PhaseLog } from "./phases.ts";

test("phases report where an attempt failed and never replace its error", () => {
  const reported: unknown[] = [];
  const log = new PhaseLog(20_000, (value) => reported.push(value));
  try {
    log.phase("stop");
    log.phase("backup");
    log.failed(20_000);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      reason: "failed",
      budgetMs: 20_000,
      phases: [{ phase: "stop" }, { phase: "backup" }],
    });
    log.failed(20_000);
    expect(reported).toHaveLength(1);
  } finally {
    log.stop();
  }
});

test("a budget that expires reports the phases reached so far", async () => {
  vi.useFakeTimers();
  const reported: unknown[] = [];
  const log = new PhaseLog(5_000, (value) => reported.push(value));
  try {
    log.phase("stop");
    log.phase("backup");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(reported).toEqual([
      {
        reason: "deadline",
        budgetMs: 5_000,
        elapsedMs: expect.any(Number),
        phases: [
          { phase: "stop", ms: expect.any(Number) },
          { phase: "backup", ms: expect.any(Number) },
        ],
      },
    ]);
    await setImmediate();
  } finally {
    log.stop();
    vi.useRealTimers();
  }
});

test("a completed attempt stays quiet", async () => {
  vi.useFakeTimers();
  const reported: unknown[] = [];
  const log = new PhaseLog(5_000, (value) => reported.push(value));
  try {
    log.phase("stop");
    log.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reported).toEqual([]);
    expect(log).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});
