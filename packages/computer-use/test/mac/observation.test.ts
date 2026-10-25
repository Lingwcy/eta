import { expect, test } from "vite-plus/test";
import { observeAfterInput } from "../../src/mac/observation.ts";

function fixture(fingerprint: (time: number) => string) {
  let time = 0;
  let captures = 0;
  const controller = new AbortController();
  return {
    controller,
    options: {
      signal: controller.signal,
      now: () => time,
      pause: async (ms: number, signal: AbortSignal) => {
        signal.throwIfAborted();
        time += ms;
      },
      capture: async () => {
        captures++;
        return fingerprint(time);
      },
    },
    captures: () => captures,
  };
}

test("waits through a transitional frame and returns the newer quiet observation", async () => {
  const f = fixture((time) => (time < 300 ? "loading" : "ready"));
  expect(await observeAfterInput(f.options)).toEqual({ observation: "stable" });
  expect(f.captures()).toBe(7);
});

test("continuous animation is bounded and reported without claiming readiness", async () => {
  const f = fixture((time) => String(time));
  expect(await observeAfterInput(f.options)).toEqual({ observation: "deadline" });
  expect(f.captures()).toBe(16);
});

test("cancellation stops polling and never returns a late capture", async () => {
  const f = fixture(() => "same");
  f.options.capture = async () => {
    f.controller.abort();
    return "same";
  };
  await expect(observeAfterInput(f.options)).rejects.toBeDefined();
});
