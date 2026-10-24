import { expect, test } from "vite-plus/test";
import { ComputerService } from "../src/service.ts";
import { ComputerError } from "../src/protocol.ts";
import type { ComputerAdapter, ComputerCapture, ComputerInput } from "../src/protocol.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture() {
  const capture: ComputerCapture = {
    image: { type: "image", data: "fixture", mimeType: "image/png" },
    width: 2880,
    height: 1800,
    layout: { id: "primary", revision: "one", bounds: { x: -100, y: 0, width: 1440, height: 900 } },
  };
  const inputs: ComputerInput[] = [];
  const adapter: ComputerAdapter = {
    layout: async () => capture.layout,
    capture: async () => structuredClone(capture),
    input: async (value) => {
      inputs.push(value);
    },
    releaseInputs: async () => {},
  };
  const owner = { active: () => true };
  const signal = new AbortController().signal;
  return { capture, inputs, adapter, owner, signal, service: new ComputerService(adapter) };
}

test("maps delivered Retina pixels, returns a new observation and rejects reuse of the old frame", async () => {
  const f = fixture();
  const first = await f.service.screenshot(f.owner, f.signal);
  const next = await f.service.input(
    f.owner,
    first.frame.id,
    { action: "click", point: { x: 1440, y: 900 }, button: "left", count: 1 },
    f.signal,
  );
  expect(f.inputs).toEqual([
    { action: "click", point: { x: 620, y: 450 }, button: "left", count: 1 },
  ]);
  expect(next.frame.id).not.toBe(first.frame.id);
  await expect(
    f.service.input(f.owner, first.frame.id, { action: "type", text: "stale" }, f.signal),
  ).rejects.toMatchObject({ code: "stale_frame" });
  expect(f.inputs).toHaveLength(1);
});

test("rejects another owner and does not let its release steal the desktop", async () => {
  const f = fixture();
  await f.service.screenshot(f.owner, f.signal);
  const other = { active: () => true };
  await f.service.release(other);
  await expect(f.service.screenshot(other, f.signal)).rejects.toMatchObject({ code: "busy" });
  await f.service.release(f.owner);
  await f.service.screenshot(other, f.signal);
  await f.service.release(f.owner);
  await expect(f.service.screenshot(f.owner, f.signal)).rejects.toMatchObject({ code: "busy" });
});

test("layout changes invalidate input before any native event", async () => {
  const f = fixture();
  const first = await f.service.screenshot(f.owner, f.signal);
  f.capture.layout.revision = "two";
  await expect(
    f.service.input(f.owner, first.frame.id, { action: "type", text: "wrong window" }, f.signal),
  ).rejects.toMatchObject({ code: "stale_frame" });
  expect(f.inputs).toEqual([]);
});

test("stop waits for a held adapter, rejects late capture and coalesces cleanup", async () => {
  const f = fixture();
  const entered = gate();
  const held = gate();
  f.adapter.capture = async () => {
    entered.release();
    await held.promise;
    return f.capture;
  };
  const pending = f.service.screenshot(f.owner, f.signal);
  const rejected = expect(pending).rejects.toBeDefined();
  await entered.promise;
  try {
    const stopped = f.service.release(f.owner);
    expect(f.service.release(f.owner)).toBe(stopped);
    await expect(f.service.screenshot({ active: () => true }, f.signal)).rejects.toMatchObject({
      code: "busy",
    });
    held.release();
    await rejected;
    await stopped;
    await f.service.screenshot({ active: () => true }, f.signal);
  } finally {
    held.release();
    await rejected;
  }
});

test("a revoked owner cannot publish an observation or start input", async () => {
  const f = fixture();
  let active = true;
  const owner = { active: () => active };
  f.adapter.capture = async () => {
    active = false;
    return f.capture;
  };
  await expect(f.service.screenshot(owner, f.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(f.inputs).toEqual([]);
  await f.service.release(owner);
});

test("a partial native failure releases inputs and invalidates its frame", async () => {
  const f = fixture();
  let cleaned = 0;
  f.adapter.releaseInputs = async () => {
    cleaned++;
  };
  const first = await f.service.screenshot(f.owner, f.signal);
  f.adapter.input = async () => {
    throw new Error("native failure");
  };
  await expect(
    f.service.input(f.owner, first.frame.id, { action: "key", keys: ["shift"] }, f.signal),
  ).rejects.toThrow("native failure");
  expect(cleaned).toBe(2);
  await expect(
    f.service.input(f.owner, first.frame.id, { action: "type", text: "retry" }, f.signal),
  ).rejects.toMatchObject({ code: "stale_frame" });
});

test("cancellation while checking layout never starts native input", async () => {
  const f = fixture();
  const first = await f.service.screenshot(f.owner, f.signal);
  const entered = gate();
  const held = gate();
  const controller = new AbortController();
  f.adapter.layout = async () => {
    entered.release();
    await held.promise;
    return f.capture.layout;
  };
  const pending = f.service.input(
    f.owner,
    first.frame.id,
    { action: "type", text: "cancelled" },
    controller.signal,
  );
  const rejected = expect(pending).rejects.toBeDefined();
  await entered.promise;
  try {
    controller.abort();
  } finally {
    held.release();
    await rejected;
  }
  expect(f.inputs).toEqual([]);
});

test("cleanup failure poisons the lease until explicit cleanup succeeds", async () => {
  const f = fixture();
  f.adapter.releaseInputs = async () => {
    throw new Error("key remains held");
  };
  await expect(f.service.screenshot(f.owner, f.signal)).rejects.toThrow("key remains held");
  f.adapter.releaseInputs = async () => {};
  await expect(f.service.screenshot(f.owner, f.signal)).rejects.toThrow("key remains held");
  await f.service.release(f.owner);
  await f.service.screenshot({ active: () => true }, f.signal);
});

test("rejects non-finite or out-of-bounds points before native input", async () => {
  const f = fixture();
  const first = await f.service.screenshot(f.owner, f.signal);
  for (const x of [-1, NaN, Infinity, 2880]) {
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "click", point: { x, y: 0 }, button: "left", count: 1 },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_frame" });
  }
  expect(f.inputs).toEqual([]);
});

test("a failed post-action observation reports that input was already applied", async () => {
  const f = fixture();
  const first = await f.service.screenshot(f.owner, f.signal);
  f.adapter.capture = async () => {
    throw new Error("capture unavailable");
  };
  await expect(
    f.service.input(f.owner, first.frame.id, { action: "type", text: "already typed" }, f.signal),
  ).rejects.toMatchObject({ code: "observation_failed", applied: "yes" });
  expect(f.inputs).toHaveLength(1);
});

test("wait is bounded and cancellation does not publish a frame", async () => {
  const f = fixture();
  await expect(f.service.wait(f.owner, 10001, f.signal)).rejects.toMatchObject({
    code: "invalid_frame",
  });
  const controller = new AbortController();
  const pending = f.service.wait(f.owner, 10000, controller.signal);
  controller.abort();
  await expect(pending).rejects.toBeDefined();
  await f.service.release(f.owner);
});

test("failed explicit release can be retried without admitting a replacement early", async () => {
  const f = fixture();
  await f.service.screenshot(f.owner, f.signal);
  f.adapter.releaseInputs = async () => {
    throw new Error("held key");
  };
  await expect(f.service.release(f.owner)).rejects.toThrow("held key");
  await expect(f.service.screenshot({ active: () => true }, f.signal)).rejects.toMatchObject({
    code: "busy",
  });
  f.adapter.releaseInputs = async () => {};
  await f.service.release(f.owner);
  await f.service.screenshot({ active: () => true }, f.signal);
});

test("capture limits are passed to the adapter and oversized observations are rejected", async () => {
  const f = fixture();
  const limits = { maxWidth: 1280, maxHeight: 800, maxBytes: 100 };
  let received;
  f.adapter.capture = async (_signal, requested) => {
    received = requested;
    return f.capture;
  };
  await expect(f.service.screenshot(f.owner, f.signal, limits)).rejects.toMatchObject({
    code: "invalid_frame",
  });
  expect(received).toEqual(limits);
  await f.service.release(f.owner);
});

test("composite typing maps its point and captures only the final settled observation", async () => {
  const f = fixture();
  const modes: (boolean | undefined)[] = [];
  f.adapter.capture = async (_signal, _limits, afterInput) => {
    modes.push(afterInput);
    return { ...f.capture, ...(afterInput ? { observation: "stable" as const } : {}) };
  };
  const first = await f.service.screenshot(f.owner, f.signal);
  const result = await f.service.input(
    f.owner,
    first.frame.id,
    { action: "type", point: { x: 1440, y: 900 }, text: "你好", overwrite: true, enter: true },
    f.signal,
  );
  expect(f.inputs).toEqual([
    { action: "type", point: { x: 620, y: 450 }, text: "你好", overwrite: true, enter: true },
  ]);
  expect(modes).toEqual([false, true]);
  expect(result.frame.observation).toBe("stable");
});

test("invalid keys are a definite non-operation and preserve the current frame", async () => {
  const f = fixture();
  const first = await f.service.screenshot(f.owner, f.signal);
  await expect(
    f.service.input(f.owner, first.frame.id, { action: "key", keys: ["CMD", "unknown"] }, f.signal),
  ).rejects.toMatchObject({ code: "invalid_input", applied: "no" });
  await f.service.input(f.owner, first.frame.id, { action: "key", keys: ["ENTER"] }, f.signal);
  expect(f.inputs).toEqual([{ action: "key", keys: ["return"] }]);
});

function accessibleFixture() {
  const f = fixture();
  let observations = 0;
  let captures = 0;
  let resets = 0;
  const events: { id: string; input: ComputerInput }[] = [];
  f.adapter.capture = async () => {
    captures++;
    return structuredClone(f.capture);
  };
  f.adapter.accessibility = {
    observe: async (target) => ({
      id: `ax-${++observations}`,
      app: target.app,
      windowTitle: target.windowTitle ?? "test",
      text: `[${observations}] AXTextField settable`,
    }),
    input: async (state, input) => {
      events.push({ id: state.id, input });
    },
    reset: async () => {
      resets++;
    },
  };
  return { ...f, events, counts: () => ({ observations, captures, resets }) };
}

test("AX observations and value changes return fresh controls without capturing images", async () => {
  const f = accessibleFixture();
  try {
    const first = await f.service.observe(
      f.owner,
      { app: "TextEdit", windowTitle: "test" },
      f.signal,
    );
    expect(first).toMatchObject({ accessibility: "[1] AXTextField settable", app: "TextEdit" });
    expect(first).not.toHaveProperty("image");
    const next = await f.service.input(
      f.owner,
      first.frame.id,
      { action: "set_value", elementIndex: 1, text: "中文" },
      f.signal,
    );
    expect(next).toMatchObject({ accessibility: "[2] AXTextField settable" });
    expect(f.events).toEqual([
      { id: "ax-1", input: { action: "set_value", elementIndex: 1, text: "中文" } },
    ]);
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "set_value", elementIndex: 1, text: "stale" },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "stale_frame", applied: "no" });
    expect(f.counts()).toEqual({ observations: 2, captures: 0, resets: 0 });
  } finally {
    await f.service.release(f.owner);
  }
  expect(f.counts().resets).toBe(1);
});

test("coordinates require an image, while explicit visual fallback retains Retina geometry", async () => {
  const f = accessibleFixture();
  try {
    const ax = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    await expect(
      f.service.input(
        f.owner,
        ax.frame.id,
        { action: "click", point: { x: 20, y: 20 }, button: "left", count: 1 },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_input", applied: "no" });
    const visual = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal, undefined, true);
    expect(visual).toHaveProperty("image");
    await f.service.input(
      f.owner,
      visual.frame.id,
      { action: "click", point: { x: 1440, y: 900 }, button: "left", count: 1 },
      f.signal,
    );
    expect(f.events[0]?.input).toEqual({
      action: "click",
      point: { x: 620, y: 450 },
      button: "left",
      count: 1,
    });
  } finally {
    await f.service.release(f.owner);
  }
});

test("a fresh targeted screenshot refreshes AX state and rejects the old frame or another owner", async () => {
  const f = accessibleFixture();
  try {
    const ax = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    await expect(
      f.service.input(
        { active: () => true },
        ax.frame.id,
        { action: "set_value", elementIndex: 1, text: "other" },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "busy" });
    const image = await f.service.screenshot(f.owner, f.signal);
    await expect(
      f.service.input(
        f.owner,
        ax.frame.id,
        { action: "set_value", elementIndex: 1, text: "old" },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "stale_frame" });
    expect(f.events).toEqual([]);
    await f.service.input(
      f.owner,
      image.frame.id,
      { action: "set_value", elementIndex: 3, text: "new" },
      f.signal,
    );
    expect(f.events).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test("stopping held AX observation drains the actual adapter before admitting its replacement", async () => {
  const f = accessibleFixture();
  const entered = gate();
  const held = gate();
  f.adapter.accessibility!.observe = async (target) => {
    entered.release();
    await held.promise;
    return { id: "late", app: target.app, windowTitle: "test", text: "late" };
  };
  const pending = f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
  const rejected = expect(pending).rejects.toBeDefined();
  let released: Promise<void> | undefined;
  try {
    await entered.promise;
    released = f.service.release(f.owner);
    await expect(f.service.screenshot({ active: () => true }, f.signal)).rejects.toMatchObject({
      code: "busy",
    });
  } finally {
    held.release();
    await rejected;
    await released;
  }
  expect(f.counts().resets).toBe(1);
  const replacement = { active: () => true };
  await f.service.screenshot(replacement, f.signal);
  await f.service.release(replacement);
});

test("AX input followed by observation failure reports applied yes and cannot replay", async () => {
  const f = accessibleFixture();
  try {
    const first = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    f.adapter.accessibility!.observe = async () => {
      throw Error("window closed");
    };
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "set_value", elementIndex: 1, text: "once" },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "observation_failed", applied: "yes" });
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "set_value", elementIndex: 1, text: "twice" },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "stale_frame", applied: "no" });
    expect(f.events).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test("post-input observation follows the same native window identity rather than an old title", async () => {
  const f = accessibleFixture();
  const targets: unknown[] = [];
  f.adapter.accessibility!.observe = async (target) => {
    targets.push(target);
    return {
      id: targets.length === 1 ? "original-window" : "renamed-window",
      app: target.app,
      windowTitle: targets.length === 1 ? "before" : "after",
      text: "[1] AXTextField",
    };
  };
  try {
    const first = await f.service.observe(
      f.owner,
      { app: "test", windowTitle: "before" },
      f.signal,
    );
    const next = await f.service.input(
      f.owner,
      first.frame.id,
      { action: "set_value", elementIndex: 1, text: "rename" },
      f.signal,
    );
    expect(targets).toEqual([
      { app: "test", windowTitle: "before" },
      { app: "test", previousId: "original-window" },
    ]);
    expect(next).toMatchObject({ windowTitle: "after" });
  } finally {
    await f.service.release(f.owner);
  }
});

test("AX input that settles after stop does not publish or start a replacement observation", async () => {
  const f = accessibleFixture();
  const entered = gate();
  const held = gate();
  f.adapter.accessibility!.input = async () => {
    entered.release();
    await held.promise;
  };
  const first = await f.service.observe(f.owner, { app: "test" }, f.signal);
  const pending = f.service.input(
    f.owner,
    first.frame.id,
    { action: "set_value", elementIndex: 1, text: "held" },
    f.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({
    code: "observation_failed",
    applied: "yes",
  });
  let releasing: Promise<void> | undefined;
  try {
    await entered.promise;
    releasing = f.service.release(f.owner);
  } finally {
    held.release();
    await rejected;
    await releasing;
  }
  expect(f.counts().observations).toBe(1);
});

test("opening an app needs no frame or screenshot and rejects invalid application names before input", async () => {
  const f = accessibleFixture();
  try {
    await f.service.open(f.owner, "TextEdit", f.signal);
    expect(f.inputs).toEqual([{ action: "open", app: "TextEdit" }]);
    expect(f.counts().captures).toBe(0);
    await expect(f.service.open(f.owner, "pid:123", f.signal)).rejects.toMatchObject({
      code: "invalid_input",
      applied: "no",
    });
    expect(f.inputs).toEqual([{ action: "open", app: "TextEdit" }]);
    await expect(f.service.open(f.owner, "\0bad", f.signal)).rejects.toMatchObject({
      applied: "no",
      code: "invalid_input",
    });
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test("targeted screenshots preserve window identity and map resized image pixels into that window", async () => {
  const f = accessibleFixture();
  const bounds = { x: 100, y: 80, width: 600, height: 400 };
  const layout = { id: "window:42", revision: "bounds", bounds };
  let moved = false;
  f.adapter.layout = async (_signal, state) => {
    expect(state?.app).toBe("TextEdit");
    return { ...layout, revision: moved ? "moved" : "bounds" };
  };
  f.adapter.capture = async (_signal, _limits, _after, state) => {
    expect(state?.app).toBe("TextEdit");
    return {
      layout,
      width: 1200,
      height: 800,
      image: { type: "image", data: "png", mimeType: "image/png" },
    };
  };
  try {
    let image = await f.service.screenshot(f.owner, f.signal, undefined, {
      app: "TextEdit",
      windowTitle: "test",
    });
    expect(image.frame.displayId).toBe("window:42");
    await f.service.input(
      f.owner,
      image.frame.id,
      { action: "click", point: { x: 300, y: 200 }, button: "left", count: 1 },
      f.signal,
    );
    expect(f.events[0]?.input).toMatchObject({ point: { x: 250, y: 180 } });
    image = await f.service.screenshot(f.owner, f.signal);
    moved = true;
    await expect(
      f.service.input(
        f.owner,
        image.frame.id,
        { action: "click", point: { x: 300, y: 200 }, button: "left", count: 1 },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "stale_frame", applied: "no" });
    expect(f.events).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test.each(["no", "unknown"] as const)(
  "user takeover with applied=%s blocks retries and release/reacquire within the same admission",
  async (applied) => {
    const f = accessibleFixture();
    const replacement = { active: () => true };
    const first = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    let inputs = 0;
    f.adapter.accessibility!.input = async () => {
      inputs++;
      throw new ComputerError("user_interrupted", "User took over", applied);
    };
    await expect(
      f.service.input(f.owner, first.frame.id, { action: "key", keys: ["enter"] }, f.signal),
    ).rejects.toMatchObject({ code: "user_interrupted", applied });
    await expect(f.service.observe(f.owner, { app: "TextEdit" }, f.signal)).rejects.toMatchObject({
      code: "user_interrupted",
      applied: "no",
    });
    await expect(f.service.open(f.owner, "TextEdit", f.signal)).rejects.toMatchObject({
      code: "user_interrupted",
    });
    await expect(
      f.service.observe(replacement, { app: "TextEdit" }, f.signal),
    ).rejects.toMatchObject({ code: "busy" });
    await f.service.release(f.owner);
    await expect(f.service.screenshot(f.owner, f.signal)).rejects.toMatchObject({
      code: "user_interrupted",
    });
    await f.service.observe(replacement, { app: "TextEdit" }, f.signal);
    expect(inputs).toBe(1);
    expect(f.inputs).toEqual([]);
    expect(f.counts()).toEqual({ observations: 2, captures: 0, resets: 1 });
    await f.service.release(replacement);
  },
);

test("takeover detected after AX input retains applied yes and blocks a fresh observation", async () => {
  const f = accessibleFixture();
  try {
    const first = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    f.adapter.accessibility!.observe = async () => {
      throw new ComputerError("user_interrupted", "User took over", "no");
    };
    await expect(
      f.service.input(f.owner, first.frame.id, { action: "type", text: "once" }, f.signal),
    ).rejects.toMatchObject({ code: "user_interrupted", applied: "yes" });
    await expect(f.service.wait(f.owner, 0, f.signal)).rejects.toMatchObject({
      code: "user_interrupted",
      applied: "no",
    });
    expect(f.events).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test("release retains a takeover that happened between operations before native state is discarded", async () => {
  const f = accessibleFixture();
  await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
  const entered = gate();
  const held = gate();
  f.adapter.checkOwnership = async () => {
    entered.release();
    await held.promise;
    throw new ComputerError("user_interrupted", "User clicked between calls");
  };
  const releasing = f.service.release(f.owner);
  const replacement = { active: () => true };
  try {
    await entered.promise;
    await expect(
      f.service.observe(replacement, { app: "TextEdit" }, f.signal),
    ).rejects.toMatchObject({ code: "busy" });
    expect(f.counts().resets).toBe(0);
  } finally {
    held.release();
    await releasing;
  }
  expect(f.counts().resets).toBe(1);
  await expect(f.service.observe(f.owner, { app: "TextEdit" }, f.signal)).rejects.toMatchObject({
    code: "user_interrupted",
  });
  f.adapter.checkOwnership = async () => {};
  await f.service.observe(replacement, { app: "TextEdit" }, f.signal);
  await f.service.release(replacement);
});

test("visual input and post-input capture preserve takeover instead of treating it as a retryable capture failure", async () => {
  for (const phase of ["input", "capture"] as const) {
    const f = fixture();
    try {
      const first = await f.service.screenshot(f.owner, f.signal);
      if (phase === "input")
        f.adapter.input = async () => {
          throw new ComputerError("user_interrupted", "takeover", "unknown");
        };
      else
        f.adapter.capture = async () => {
          throw new ComputerError("user_interrupted", "takeover");
        };
      await expect(
        f.service.input(f.owner, first.frame.id, { action: "type", text: "once" }, f.signal),
      ).rejects.toMatchObject({
        code: "user_interrupted",
        applied: phase === "input" ? "unknown" : "yes",
      });
      await expect(f.service.screenshot(f.owner, f.signal)).rejects.toMatchObject({
        code: "user_interrupted",
        applied: "no",
      });
    } finally {
      await f.service.release(f.owner);
    }
  }
});

test("one polyline maps every Retina point and validates the complete route before any input", async () => {
  const f = fixture();
  try {
    const first = await f.service.screenshot(f.owner, f.signal);
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        {
          action: "drag",
          from: { x: 20, y: 20 },
          to: { x: 40, y: 40 },
          path: [
            { x: 20, y: 20 },
            { x: 5000, y: 30 },
            { x: 40, y: 40 },
          ],
        },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_frame" });
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "drag", from: { x: 20, y: 20 }, to: { x: 40, y: 40 }, durationMs: -1 },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.inputs).toEqual([]);
    await f.service.input(
      f.owner,
      first.frame.id,
      {
        action: "drag",
        from: { x: 20, y: 20 },
        to: { x: 40, y: 40 },
        path: [
          { x: 20, y: 20 },
          { x: 30, y: 50 },
          { x: 40, y: 40 },
        ],
        durationMs: 450,
      },
      f.signal,
    );
    expect(f.inputs).toEqual([
      {
        action: "drag",
        from: { x: -90, y: 10 },
        to: { x: -80, y: 20 },
        path: [
          { x: -90, y: 10 },
          { x: -85, y: 25 },
          { x: -80, y: 20 },
        ],
        durationMs: 450,
      },
    ]);
  } finally {
    await f.service.release(f.owner);
  }
});

test("redundant application hints match admitted aliases, cannot retarget a frame and survive refreshed native bundle IDs", async () => {
  const f = fixture();
  let snapshot = 0;
  f.adapter.accessibility = {
    observe: async () => ({
      id: String(++snapshot),
      app: "com.google.Chrome",
      windowTitle: "test",
      text: "[0] AXButton",
    }),
    input: async (_state, input) => {
      f.inputs.push(input);
    },
    reset: async () => {},
  };
  try {
    const first = await f.service.observe(f.owner, { app: "Google Chrome" }, f.signal);
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "click", elementIndex: 0, button: "left", count: 1 },
        f.signal,
        undefined,
        "TextEdit",
      ),
    ).rejects.toMatchObject({ code: "invalid_input", applied: "no" });
    expect(f.inputs).toEqual([]);
    const second = await f.service.input(
      f.owner,
      first.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
      undefined,
      "google chrome",
    );
    await f.service.input(
      f.owner,
      second.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
      undefined,
      "Google Chrome",
    );
    expect(f.inputs).toHaveLength(2);
  } finally {
    await f.service.release(f.owner);
  }
});
