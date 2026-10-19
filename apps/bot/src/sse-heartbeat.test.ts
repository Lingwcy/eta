import { afterEach, expect, test, vi } from "vite-plus/test";
import { heartbeat } from "./sse-heartbeat.ts";

afterEach(() => vi.useRealTimers());

test("a stalled reader never accumulates heartbeat writes and stop suppresses late errors", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<void>();
  const writeSSE = vi.fn(() => pending.promise);
  const failed = vi.fn();
  const stop = heartbeat({ writeSSE }, failed);
  try {
    await vi.advanceTimersByTimeAsync(15000);
    expect(writeSSE).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300000);
    expect(writeSSE).toHaveBeenCalledTimes(1);
    stop();
    pending.reject(new Error("late closed stream"));
    await vi.advanceTimersByTimeAsync(60000);
    expect(writeSSE).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop();
    pending.resolve();
  }
});

test("a current heartbeat failure ends observation and its timer can be released", async () => {
  vi.useFakeTimers();
  const writeSSE = vi.fn().mockRejectedValue(new Error("closed stream"));
  const failed = vi.fn(() => stop());
  const stop = heartbeat({ writeSSE }, failed);
  try {
    await vi.advanceTimersByTimeAsync(15000);
    expect(failed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(writeSSE).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop();
  }
});
