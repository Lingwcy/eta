import { expect, test } from "vite-plus/test";
import { ComputerService } from "../src/service.ts";
import type { ComputerActivity, ComputerPointer } from "../src/presentation.ts";
import type { ComputerAdapter } from "../src/protocol.ts";

function fixture() {
  const events: ComputerActivity[] = [],
    inputs: unknown[] = [];
  let snapshot = 0;
  const bounds = { x: -300, y: 40, width: 600, height: 400 };
  const adapter: ComputerAdapter = {
    layout: async () => ({ id: "window", revision: "one", bounds }),
    capture: async () => ({
      layout: { id: "window", revision: "one", bounds },
      width: 600,
      height: 400,
      image: { type: "image", data: "host-only", mimeType: "image/png" },
    }),
    input: async (value) => {
      inputs.push(value);
    },
    releaseInputs: async () => {},
    accessibility: {
      observe: async (target) => ({
        id: String(++snapshot),
        app: target.app,
        windowTitle: "test",
        windowId: 42,
        bounds,
        text: "[0] AXButton",
      }),
      input: async (state, value) => {
        inputs.push({ state, value });
      },
      reset: async () => {},
    },
  };
  const service = new ComputerService(adapter, (event) => events.push(event)),
    owner = { active: () => true },
    signal = AbortSignal.timeout(5000);
  const pointer: ComputerPointer = {
    snapshot: "1",
    windowId: 42,
    point: { x: -200, y: 60 },
    bounds,
    phase: "up",
    visible: true,
  };
  return { events, inputs, adapter, service, owner, signal, pointer };
}

test("AX-only results remain image-free while the host preview and actual input share the observed identity", async () => {
  const f = fixture();
  try {
    const observed = await f.service.observe(f.owner, { app: "test" }, f.signal);
    expect(observed).not.toHaveProperty("image");
    expect(f.events.map((e) => e.type)).toEqual(["start", "target", "frame"]);
    f.service.presentPointer(f.pointer);
    expect(f.events.at(-1)).toMatchObject({ type: "pointer", pointer: f.pointer });
    await f.service.input(
      f.owner,
      observed.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
    );
    expect(f.inputs).toMatchObject([
      { state: { id: "1", windowId: 42 }, value: { action: "click" } },
    ]);
    const count = f.events.length;
    f.service.presentPointer(f.pointer);
    expect(f.events).toHaveLength(count);
  } finally {
    await f.service.release(f.owner);
  }
  expect(f.events.at(-1)).toMatchObject({ type: "end" });
});

test("closing presentation cancels held work, hides immediately, and cannot reacquire the same admission", async () => {
  const f = fixture();
  let started!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => {
      started = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const original = f.adapter.capture.bind(f.adapter);
  f.adapter.capture = async (...args) => {
    started();
    await gate;
    return original(...args);
  };
  const pending = f.service.observe(f.owner, { app: "test" }, f.signal);
  const failure = pending.catch((error) => error);
  try {
    await ready;
    const id = f.events[0]!.id,
      release = f.service.stopPresentation(id);
    expect(f.events.at(-1)).toEqual({ type: "end", id });
    finish();
    await release;
    await failure;
    expect(f.events.filter((e) => e.type === "frame")).toHaveLength(0);
    await expect(f.service.observe(f.owner, { app: "test" }, f.signal)).rejects.toMatchObject({
      code: "user_interrupted",
    });
    const next = { active: () => true };
    await f.service.observe(next, { app: "test" }, f.signal);
    const active = f.events.filter((e) => e.type === "start").at(-1)!;
    await f.service.stopPresentation(id);
    expect(f.events.at(-1)?.id).toBe(active.id);
    expect(f.events.at(-1)?.type).toBe("frame");
    await f.service.release(next);
  } finally {
    finish();
    await pending.catch(() => {});
    await f.service.release(f.owner);
  }
});

test("telemetry cannot paint a different window or changed geometry and preview failure never replays input", async () => {
  const f = fixture();
  f.adapter.capture = async () => {
    throw Error("Preview unavailable");
  };
  try {
    const observed = await f.service.observe(f.owner, { app: "test" }, f.signal);
    const count = f.events.length;
    f.service.presentPointer({ ...f.pointer, windowId: 43 });
    f.service.presentPointer({ ...f.pointer, bounds: { ...f.pointer.bounds, x: 500 } });
    expect(f.events).toHaveLength(count);
    await f.service.input(
      f.owner,
      observed.frame.id,
      { action: "click", elementIndex: 0, button: "left", count: 1 },
      f.signal,
    );
    expect(f.inputs).toHaveLength(1);
  } finally {
    await f.service.release(f.owner);
  }
});

test("visual results and the preview share one capture without replacing the delivered coordinate frame", async () => {
  const f = fixture();
  let captures = 0;
  const original = f.adapter.capture.bind(f.adapter);
  f.adapter.capture = async (...args) => {
    captures++;
    return original(...args);
  };
  try {
    const observed = await f.service.observe(f.owner, { app: "test" }, f.signal, undefined, true);
    const result = await f.service.input(
      f.owner,
      observed.frame.id,
      { action: "click", point: { x: 100, y: 20 }, button: "left", count: 1 },
      f.signal,
    );
    expect(captures).toBe(2);
    expect(f.inputs).toMatchObject([
      { state: { id: "1" }, value: { action: "click", point: { x: -200, y: 60 } } },
    ]);
    expect(f.events.filter((e) => e.type === "frame").map((e) => e.image)).toEqual([
      observed.image,
      result.image,
    ]);
  } finally {
    await f.service.release(f.owner);
  }
});

test("a screenshot with a baked cursor does not leave a second cursor in the live preview", async () => {
  const f = fixture();
  const observe = f.adapter.accessibility!.observe.bind(f.adapter.accessibility);
  f.adapter.accessibility!.observe = async (...args) => ({
    ...(await observe(...args)),
    cursor: { x: 20, y: 30 },
  });
  f.adapter.capture = async (_signal, limits) => ({
    layout: { id: "window", revision: "one", bounds: f.pointer.bounds },
    width: 600,
    height: 400,
    image: {
      type: "image",
      data: limits?.includeCursor === false ? "clean-preview" : "baked-cursor",
      mimeType: "image/png",
    },
  });
  try {
    const result = await f.service.observe(f.owner, { app: "test" }, f.signal, undefined, true);
    expect(result.image?.data).toBe("baked-cursor");
    expect(f.events.at(-1)).toMatchObject({ type: "frame", image: { data: "clean-preview" } });
  } finally {
    await f.service.release(f.owner);
  }
});
