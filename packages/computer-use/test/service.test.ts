import { expect, test } from "vite-plus/test";
import { ComputerService } from "../src/service.ts";
import { ComputerError } from "../src/protocol.ts";
import type {
  ComputerAdapter,
  ComputerCapture,
  ComputerInput,
  ComputerTarget,
  ComputerObservation,
} from "../src/protocol.ts";

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

test("an invalid select preserves the latest frame and a valid select delivers only to its bound container", async () => {
  const f = fixture();
  let reads = 0;
  f.adapter.accessibility = {
    observe: async () => ({
      id: String(++reads),
      app: "test",
      windowTitle: "window",
      text: "[0] AXPopUpButton",
    }),
    input: async (state, input) => {
      expect(state.id).toBe("1");
      f.inputs.push(input);
      return { applied: "yes", verification: { status: "satisfied" } };
    },
    reset: async () => {},
  };
  const first = await f.service.observe(f.owner, { app: "test" }, f.signal);
  const select = { action: "select", elementIndex: 0, name: "Beta" } as const;
  for (const invalid of [
    { ...select, name: "" },
    { ...select, elementIndex: 0.5 },
  ]) {
    await expect(f.service.input(f.owner, first.frame.id, invalid, f.signal)).rejects.toMatchObject(
      { code: "invalid_input", applied: "no" },
    );
  }
  const result = await f.service.input(f.owner, first.frame.id, select, f.signal);
  expect(result).toMatchObject({ applied: "yes", verification: { status: "satisfied" } });
  expect(result.frame.id).not.toBe(first.frame.id);
  expect(f.inputs).toEqual([select]);
  await f.service.release(f.owner);
});

test.each([false, true])(
  "state receipt preserves delivery and verification when follow-up observation fails (%s)",
  async (sent) => {
    const f = fixture();
    const verification = sent
      ? { status: "unknown" as const, reason: "state_unavailable" }
      : { status: "satisfied" as const, noOp: true };
    let observations = 0;
    let deliveries = 0;
    f.adapter.accessibility = {
      observe: async () => {
        if (observations++ > 0) throw new Error("Readback unavailable");
        return { id: "one", app: "test", windowTitle: "window", text: '[0] AXCheckBox value="1"' };
      },
      input: async () => {
        if (sent) deliveries++;
        return { applied: sent ? "yes" : "no", verification };
      },
      reset: async () => {},
    };
    const first = await f.service.observe(f.owner, { app: "test" }, f.signal);
    const input = { action: "set_checked", elementIndex: 0, state: true } as const;
    await expect(f.service.input(f.owner, first.frame.id, input, f.signal)).rejects.toMatchObject({
      code: "observation_failed",
      applied: sent ? "yes" : "no",
      verification,
    });
    await expect(f.service.input(f.owner, first.frame.id, input, f.signal)).rejects.toMatchObject({
      code: "stale_frame",
      applied: "no",
    });
    expect(deliveries).toBe(sent ? 1 : 0);
    await f.service.release(f.owner);
  },
);

test("cleanup failure preserves a completed state action's receipt", async () => {
  const f = fixture();
  let sent = 0;
  let observations = 0;
  f.adapter.accessibility = {
    observe: async () => ({
      id: String(++observations),
      app: "test",
      windowTitle: "window",
      text: '[0] AXDisclosureTriangle expanded="0"',
    }),
    input: async () => {
      sent++;
      return { applied: "yes", verification: { status: "satisfied" } };
    },
    reset: async () => {},
  };
  const first = await f.service.observe(f.owner, { app: "test" }, f.signal);
  f.adapter.releaseInputs = async () => {
    throw new Error("Native cleanup failed");
  };
  await expect(
    f.service.input(
      f.owner,
      first.frame.id,
      { action: "set_expanded", elementIndex: 0, state: false },
      f.signal,
    ),
  ).rejects.toMatchObject({
    applied: "yes",
    message: "Native cleanup failed",
    verification: { status: "satisfied" },
  });
  expect(sent).toBe(1);
  f.adapter.releaseInputs = async () => {};
  await f.service.release(f.owner);
});

test("conditional wait returns a new AX frame on timeout without issuing input or capturing a screenshot", async () => {
  const f = fixture();
  const firstState = {
    id: "original",
    app: "test",
    windowTitle: "window",
    text: "[0] AXWindow",
    windowId: 12,
  };
  const captures: string[] = [];
  const observed: string[] = [];
  f.adapter.capture = async () => {
    captures.push("preview");
    return f.capture;
  };
  f.adapter.accessibility = {
    observe: async () => firstState,
    input: async (_state, input) => {
      f.inputs.push(input);
    },
    waitUntil: async (state, condition) => {
      expect(condition).toEqual({ kind: "present", text: "Saved" });
      observed.push(state.id);
      return {
        outcome: {
          status: "timeout",
          last: "unknown",
          final: "unsatisfied",
          samples: 2,
          probeReads: 24,
        },
        state: { ...firstState, id: "final", text: '[0] AXWindow\n  [1] AXButton AXTitle="Save"' },
      };
    },
    reset: async () => {},
  };
  const service = new ComputerService(f.adapter, () => {});
  const first = await service.observe(f.owner, { app: "test" }, f.signal);
  const result = await service.waitUntil(
    f.owner,
    first.frame.id,
    { kind: "present", text: "Saved" },
    1000,
    f.signal,
  );
  expect(result.wait).toMatchObject({ status: "timeout", final: "unsatisfied" });
  expect(result.frame?.id).not.toBe(first.frame.id);
  expect(result.accessibility).toContain("AXButton");
  expect(captures).toEqual(["preview"]);
  expect(observed).toEqual(["original"]);
  expect(f.inputs).toEqual([]);
  await expect(
    service.waitUntil(f.owner, first.frame.id, { kind: "absent", text: "Saved" }, 1000, f.signal),
  ).rejects.toMatchObject({ code: "stale_frame", applied: "no" });
  await service.release(f.owner);
});

test("stopping a pending conditional wait drains its owner and rejects the late frame", async () => {
  const f = fixture();
  const entered = gate();
  const held = gate();
  const state = { id: "original", app: "test", windowTitle: "window", text: "[0] AXWindow" };
  f.adapter.accessibility = {
    observe: async () => state,
    input: async () => {
      throw new Error("Unexpected input");
    },
    waitUntil: async () => {
      entered.release();
      await held.promise;
      return {
        outcome: {
          status: "satisfied",
          last: "satisfied",
          final: "satisfied",
          samples: 1,
          probeReads: 8,
        },
        state: { ...state, id: "late" },
      };
    },
    reset: async () => {},
  };
  let admission = "";
  const service = new ComputerService(f.adapter, (event) => {
    if (event.type === "start") admission = event.id;
  });
  const first = await service.observe(f.owner, { app: "test" }, f.signal);
  const pending = service.waitUntil(
    f.owner,
    first.frame.id,
    { kind: "absent", text: "Loading" },
    1000,
    f.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await entered.promise;
  const stopped = service.stopPresentation(admission);
  const replacement = { active: () => true };
  try {
    await expect(service.observe(replacement, { app: "test" }, f.signal)).rejects.toMatchObject({
      code: "busy",
    });
  } finally {
    held.release();
    await stopped;
  }
  await rejected;
  await expect(service.observe(f.owner, { app: "test" }, f.signal)).rejects.toMatchObject({
    code: "user_interrupted",
  });
  await service.observe(replacement, { app: "test" }, f.signal);
  await service.release(replacement);
});

test("region frames retain scope after input, invalidate old indexes and report window fallback without a cross-scope diff", async () => {
  const f = fixture();
  const targets: ComputerTarget[] = [];
  let fallback = false;
  let calls = 0;
  const text = Array.from(
    { length: 10 },
    (_, index) => `[${index}] AXButton AXTitle="Same ${index}"`,
  ).join("\n");
  f.adapter.accessibility = {
    observe: async (target) => {
      targets.push(target);
      const observation: ComputerObservation = {
        scope: target.rootIndex === undefined || fallback ? "window" : "region",
        projection: target.projection ?? "full",
        complete: true,
        exhaustive: target.projection !== "overview",
        boundaries: [],
        unknown: [],
        visitedNodes: 10,
        axReads: 100,
        ...(fallback ? { fallback: "root_unavailable" } : {}),
      };
      return { id: `native-${++calls}`, app: "test", windowTitle: "window", text, observation };
    },
    input: async (_state, input) => {
      f.inputs.push(input);
    },
    reset: async () => {},
  };
  const first = await f.service.observe(f.owner, { app: "test", projection: "overview" }, f.signal);
  const region = await f.service.observe(
    f.owner,
    {
      app: "test",
      frameId: first.frame.id,
      rootIndex: 6,
      projection: "compact",
    },
    f.signal,
  );
  expect(targets[1]).toEqual({
    app: "test",
    previousId: "native-1",
    rootIndex: 6,
    projection: "compact",
  });
  expect(region.accessibility).toBe(text);
  await expect(
    f.service.input(
      f.owner,
      first.frame.id,
      {
        action: "click",
        elementIndex: 6,
        button: "left",
        count: 1,
      },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: "stale_frame", applied: "no" });
  const next = await f.service.input(
    f.owner,
    region.frame.id,
    {
      action: "click",
      elementIndex: 2,
      button: "left",
      count: 1,
    },
    f.signal,
  );
  expect(targets[2]).toEqual({
    app: "test",
    previousId: "native-2",
    rootIndex: 0,
    projection: "compact",
    fallbackToWindow: true,
  });
  expect(next).toMatchObject({ applied: "yes", verification: { status: "unverified" } });
  expect(next.accessibility).not.toBe(text);
  fallback = true;
  const recovered = await f.service.input(
    f.owner,
    next.frame.id,
    {
      action: "click",
      elementIndex: 2,
      button: "left",
      count: 1,
    },
    f.signal,
  );
  expect(recovered.accessibility).toBe(text);
  expect(recovered).toMatchObject({
    observation: { scope: "window", fallback: "root_unavailable" },
  });
  expect(f.inputs).toHaveLength(2);
  await f.service.release(f.owner);
});

test("region parameter and frame rejections preserve the current frame and never retarget another window", async () => {
  const f = fixture();
  let reads = 0;
  f.adapter.accessibility = {
    observe: async () => {
      reads++;
      return { id: "one", app: "test", windowTitle: "original", text: "[0] AXWindow" };
    },
    input: async (_state, input) => {
      f.inputs.push(input);
    },
    reset: async () => {},
  };
  const first = await f.service.observe(f.owner, { app: "test" }, f.signal);
  for (const target of [
    { app: "test", rootIndex: 0 },
    { app: "test", frameId: first.frame.id, rootIndex: -1 },
    { app: "test", frameId: "old", rootIndex: 0 },
    { app: "other", frameId: first.frame.id, rootIndex: 0 },
    { app: "test", windowTitle: "another", frameId: first.frame.id, rootIndex: 0 },
  ]) {
    await expect(f.service.observe(f.owner, target, f.signal)).rejects.toBeDefined();
  }
  expect(reads).toBe(1);
  await f.service.input(f.owner, first.frame.id, { action: "key", keys: ["Enter"] }, f.signal);
  expect(f.inputs).toHaveLength(1);
  await f.service.release(f.owner);
});

test("a cancelled region candidate cannot publish or restore the consumed frame", async () => {
  const f = fixture();
  const entered = gate();
  const held = gate();
  f.adapter.accessibility = {
    observe: async (target) => {
      if (target.rootIndex !== undefined) {
        entered.release();
        await held.promise;
      }
      return { id: "native", app: "test", windowTitle: "window", text: "[0] AXGroup" };
    },
    input: async (_state, input) => {
      f.inputs.push(input);
    },
    reset: async () => {},
  };
  const first = await f.service.observe(f.owner, { app: "test" }, f.signal);
  const controller = new AbortController();
  const candidate = f.service.observe(
    f.owner,
    {
      app: "test",
      frameId: first.frame.id,
      rootIndex: 0,
      projection: "compact",
    },
    controller.signal,
  );
  const rejected = expect(candidate).rejects.toBeDefined();
  await entered.promise;
  try {
    controller.abort();
  } finally {
    held.release();
    await rejected;
  }
  await expect(
    f.service.input(
      f.owner,
      first.frame.id,
      {
        action: "click",
        elementIndex: 0,
        button: "left",
        count: 1,
      },
      f.signal,
    ),
  ).rejects.toMatchObject({ code: "stale_frame" });
  expect(f.inputs).toEqual([]);
  await f.service.release(f.owner);
});

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

test.each([false, true])(
  "chords press modifiers before action keys on the AX path=%s",
  async (ax) => {
    const cases = [
      { keys: ["Enter", "Command"], expected: ["cmd", "return"] },
      { keys: ["A", "Shift", "Command", "shift"], expected: ["shift", "cmd", "a"] },
      { keys: ["Command", "a"], expected: ["cmd", "a"] },
      { keys: ["ArrowLeft", "CTRL", "Option"], expected: ["control", "alt", "left"] },
      { keys: ["Shift", "shift"], expected: ["shift"] },
      { keys: ["a", "b", "Fn"], expected: ["fn", "a", "b"] },
    ];
    const f = accessibleFixture();
    try {
      for (const { keys, expected } of cases) {
        const original = [...keys];
        const frame = ax
          ? await f.service.observe(f.owner, { app: "TextEdit" }, f.signal)
          : await f.service.screenshot(f.owner, f.signal);
        await f.service.input(f.owner, frame.frame.id, { action: "key", keys }, f.signal);
        expect(ax ? f.events.at(-1)?.input : f.inputs.at(-1)).toEqual({
          action: "key",
          keys: expected,
        });
        expect(keys).toEqual(original);
      }
    } finally {
      await f.service.release(f.owner);
    }
  },
);

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
        { app: "TextEdit" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", applied: "no" });
    expect(f.inputs).toEqual([]);
    await expect(
      f.service.input(
        f.owner,
        first.frame.id,
        { action: "click", elementIndex: 0, button: "left", count: 1 },
        f.signal,
        undefined,
        { app: "Google Chrome", windowTitle: "another window" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", applied: "no" });
    expect(f.inputs).toEqual([]);
    const second = await f.service.input(
      f.owner,
      first.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
      undefined,
      { app: "google chrome", windowTitle: "TES" },
    );
    await f.service.input(
      f.owner,
      second.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
      undefined,
      { app: "Google Chrome", windowTitle: "test" },
    );
    expect(f.inputs).toHaveLength(2);
  } finally {
    await f.service.release(f.owner);
  }
});

test.each(["no", "unknown"] as const)(
  "manual interaction with applied=%s invalidates the frame but permits the same task to continue",
  async (applied) => {
    const f = accessibleFixture();
    const originalInput = f.adapter.accessibility!.input.bind(f.adapter.accessibility);
    try {
      const first = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
      let attempts = 0;
      f.adapter.accessibility!.input = async () => {
        attempts++;
        throw new ComputerError("stale_frame", "Manual interaction", applied);
      };
      await expect(
        f.service.input(f.owner, first.frame.id, { action: "type", text: "once" }, f.signal),
      ).rejects.toMatchObject({ code: "stale_frame", applied });
      await expect(
        f.service.input(f.owner, first.frame.id, { action: "type", text: "replay" }, f.signal),
      ).rejects.toMatchObject({ code: "stale_frame", applied: "no" });
      expect(attempts).toBe(1);
      f.adapter.accessibility!.input = originalInput;
      const next = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
      await f.service.input(f.owner, next.frame.id, { action: "type", text: "continue" }, f.signal);
      expect(f.events).toHaveLength(1);
      // Release must drain the old helper, without permanently stopping this owner.
      f.adapter.checkOwnership = async () => {
        throw new ComputerError("stale_frame", "Manual interaction");
      };
      await f.service.release(f.owner);
      await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    } finally {
      await f.service.release(f.owner);
    }
  },
);

test("manual interaction after applied input preserves execution certainty and allows re-observation", async () => {
  const f = accessibleFixture();
  const originalObserve = f.adapter.accessibility!.observe.bind(f.adapter.accessibility);
  try {
    const first = await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    f.adapter.accessibility!.observe = async () => {
      throw new ComputerError("stale_frame", "Manual interaction");
    };
    await expect(
      f.service.input(f.owner, first.frame.id, { action: "type", text: "once" }, f.signal),
    ).rejects.toMatchObject({ code: "stale_frame", applied: "yes" });
    f.adapter.accessibility!.observe = originalObserve;
    await f.service.observe(f.owner, { app: "TextEdit" }, f.signal);
    expect(f.events).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test("menu-bar screenshots stay on the selected icon and pressing it observes the opened panel", async () => {
  const f = accessibleFixture();
  const targets: unknown[] = [];
  const original = f.adapter.accessibility!.observe.bind(f.adapter.accessibility);
  f.adapter.accessibility!.observe = async (target, signal) => {
    targets.push(target);
    const state = await original(target, signal);
    return { ...state, windowTitle: target.surface ? "TextEdit menu bar" : "panel" };
  };
  try {
    const icon = await f.service.observe(
      f.owner,
      { app: "TextEdit", surface: "menu_bar" },
      f.signal,
    );
    expect(icon.windowTitle).toBe("TextEdit menu bar");
    const screenshot = await f.service.screenshot(f.owner, f.signal);
    expect(screenshot).toHaveProperty("windowTitle", "TextEdit menu bar");
    expect(targets.at(-1)).toMatchObject({ app: "TextEdit", surface: "menu_bar" });
    const panel = await f.service.input(
      f.owner,
      screenshot.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
    );
    expect(panel).toHaveProperty("windowTitle", "panel");
    expect(targets.at(-1)).not.toHaveProperty("surface");
    expect(f.events).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});
