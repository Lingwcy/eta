import { setTimeout as delay } from "node:timers/promises";

/** Bounded visual quietness is a capture heuristic, not proof that the application finished its task. */
export async function observeAfterInput(options: {
  capture(): Promise<string>;
  signal: AbortSignal;
  now?: () => number;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const now = options.now ?? (() => performance.now());
  const pause =
    options.pause ??
    (async (ms, signal) => {
      await delay(ms, undefined, { signal });
    });
  const start = now();
  options.signal.throwIfAborted();
  let latest = await options.capture();
  options.signal.throwIfAborted();
  let quietSince = now();
  while (now() - start < 1500) {
    await pause(Math.min(100, 1500 - (now() - start)), options.signal);
    options.signal.throwIfAborted();
    const next = await options.capture();
    options.signal.throwIfAborted();
    if (next !== latest) quietSince = now();
    latest = next;
    if (now() - start >= 400 && now() - quietSince >= 250)
      return { observation: "stable" as const };
  }
  return { observation: "deadline" as const };
}
