import { afterEach, expect, test, vi } from "vite-plus/test";
import { setTimeout as delay } from "node:timers/promises";

vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return { ...original, setTimeout: vi.fn(original.setTimeout) };
});
import { ComputerService } from "../src/service.ts";
import type { ComputerAdapter, ComputerTarget } from "../src/protocol.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});

function fixture() {
  let reads = 0;
  const targets: ComputerTarget[] = [];
  const probes: string[] = [];
  const adapter: ComputerAdapter = {
    layout: async () => {
      throw Error("Unexpected layout");
    },
    capture: async () => {
      throw Error("Unexpected screenshot");
    },
    input: async () => {
      throw Error("Unexpected input");
    },
    releaseInputs: async () => {},
    accessibility: {
      observe: async (target) => {
        targets.push(target);
        return {
          id: String(++reads),
          app: "dev.mcl.launcher",
          windowTitle: "Launcher window",
          text: "[0] AXWindow",
        };
      },
      input: async () => {
        throw Error("Unexpected AX input");
      },
      waitUntil: async (state) => {
        probes.push(state.id);
        return {
          outcome: {
            status: "satisfied",
            last: "satisfied",
            final: "satisfied",
            samples: 1,
            probeReads: 1,
          },
          state: { ...state, id: String(++reads), text: "[0] AXWindow Saved" },
        };
      },
      reset: async () => {},
    },
  };
  const owner = { active: () => true };
  const signal = new AbortController().signal;
  const service = new ComputerService(adapter);
  cleanups.push(() => service.release(owner));
  return { service, owner, signal, targets, probes };
}

for (const mode of ["fixed", "conditional"] as const) {
  test.each([
    { app: "Other", code: "invalid_input" },
    { windowTitle: "Other", code: "invalid_input" },
    { frameId: "mistyped-frame", code: "stale_frame" },
  ])(
    mode + " wait refuses a conflicting target without consuming the current frame: %j",
    async (invalid) => {
      const f = fixture();
      const first = await f.service.observe(f.owner, { app: "MCL" }, f.signal);
      const { code, ...hint } = invalid;
      const target = { app: "mcl", windowTitle: "Launcher", frameId: first.frame.id, ...hint };
      const wait = () =>
        mode === "fixed"
          ? f.service.wait(f.owner, 0, f.signal, undefined, target)
          : f.service.waitUntil(
              f.owner,
              target.frameId,
              { kind: "present", text: "Saved" },
              1000,
              f.signal,
              target,
            );
      await expect(wait()).rejects.toMatchObject({ code, applied: "no" });
      expect(f.targets).toHaveLength(1);
      expect(f.probes).toEqual([]);
      const valid = { app: "MCL", windowTitle: "window", frameId: first.frame.id };
      const result =
        mode === "fixed"
          ? await f.service.wait(f.owner, 0, f.signal, undefined, valid)
          : await f.service.waitUntil(
              f.owner,
              first.frame.id,
              { kind: "present", text: "Saved" },
              1000,
              f.signal,
              valid,
            );
      expect(result.frame?.id).not.toBe(first.frame.id);
      expect(result).toMatchObject({ app: "dev.mcl.launcher" });
    },
  );
}

test("a framed fixed wait really waits, then refreshes only its admitted target", async () => {
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  vi.mocked(delay).mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
  });
  const f = fixture();
  const first = await f.service.observe(f.owner, { app: "MCL" }, f.signal);
  let settled = false;
  const pending = f.service.wait(f.owner, 10000, f.signal, undefined, {
    frameId: first.frame.id,
    app: "MCL",
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {},
  );
  try {
    await entered.promise;
    expect(vi.mocked(delay).mock.calls[0]?.[0]).toBe(10000);
    expect(settled).toBe(false);
    expect(f.targets).toHaveLength(1);
  } finally {
    held.resolve();
  }
  const result = await pending;
  expect(result.frame.id).not.toBe(first.frame.id);
  expect(f.targets[1]).toMatchObject({ app: "dev.mcl.launcher", previousId: "1" });
});

test("wait hints cannot select a target without an admitted frame", async () => {
  const f = fixture();
  await f.service.observe(f.owner, { app: "MCL" }, f.signal);
  await expect(
    f.service.wait(f.owner, 0, f.signal, undefined, { app: "MCL" }),
  ).rejects.toMatchObject({ code: "invalid_input", applied: "no" });
  expect(f.targets).toHaveLength(1);
});

test("cancelling a framed fixed wait never refreshes or publishes a new frame", async () => {
  const f = fixture();
  const first = await f.service.observe(f.owner, { app: "MCL" }, f.signal);
  const controller = new AbortController();
  const pending = f.service.wait(f.owner, 10000, controller.signal, undefined, {
    frameId: first.frame.id,
    app: "MCL",
  });
  const rejected = expect(pending).rejects.toBeDefined();
  controller.abort();
  await rejected;
  expect(f.targets).toHaveLength(1);
});
