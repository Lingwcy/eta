import { expect, test } from "vite-plus/test";
import { createMacComputerAdapter, type MacComputerHost } from "../../src/mac/adapter.ts";
import {
  ComputerError,
  type ComputerAccessibility,
  type ComputerCapture,
} from "../../src/protocol.ts";

function fixture() {
  const state: ComputerAccessibility = {
    id: "snapshot",
    app: "TextEdit",
    windowTitle: "test",
    text: "[1] AXTextArea",
    windowId: 42,
    bounds: { x: 100, y: 80, width: 600, height: 400 },
  };
  const capture: ComputerCapture = {
    image: { type: "image", data: "png", mimeType: "image/png" },
    width: 600,
    height: 400,
    layout: { id: "window:42", revision: "bounds", bounds: state.bounds! },
  };
  const events: unknown[] = [];
  const signal = new AbortController().signal;
  const host: MacComputerHost = {
    permissions: () => ({ screen: true, accessibility: true }),
    openApplication: async (name) => {
      events.push(["open", name]);
    },
    accessibility: {
      assertHealthy: () => {},
      checkOwnership: async () => {},
      observe: async () => state,
      execute: async (selected, operation, input) => {
        events.push([selected, operation, input]);
        return {};
      },
      layout: async () => capture.layout,
      capture: async (selected, _signal, limits) => {
        events.push(["capture", selected, limits]);
        return capture;
      },
      reset: async () => {
        events.push("reset");
      },
    },
  };
  return { state, capture, events, signal, host, adapter: createMacComputerAdapter(host) };
}

test("refuses untargeted screenshots and global input without opening or capturing anything", async () => {
  const f = fixture();
  await expect(f.adapter.capture(f.signal)).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    f.adapter.input({ action: "click", point: { x: 1, y: 2 }, button: "left", count: 1 }, f.signal),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(f.events).toEqual([]);
});
test("screenshots bind to the opaque observation instead of the primary screen", async () => {
  const f = fixture();
  expect(await f.adapter.capture(f.signal, { maxWidth: 600 }, false, f.state)).toEqual(f.capture);
  expect(f.events).toEqual([["capture", f.state, { maxWidth: 600 }]]);
});
test("revoked permissions stop targeted native mutations and capture", async () => {
  const f = fixture();
  f.host.permissions = () => ({ screen: true, accessibility: false });
  await expect(f.adapter.capture(f.signal, undefined, false, f.state)).rejects.toThrow("辅助功能");
  await expect(
    f.adapter.accessibility!.input(f.state, { action: "type", text: "never" }, f.signal),
  ).rejects.toThrow("辅助功能");
  expect(f.events).toEqual([]);
});
test("native failures are propagated without retrying input or activating another window", async () => {
  const f = fixture();
  let count = 0;
  f.host.accessibility.execute = async () => {
    count++;
    throw Error("window closed");
  };
  await expect(
    f.adapter.accessibility!.input(
      f.state,
      { action: "type", text: "partial", enter: true },
      f.signal,
    ),
  ).rejects.toThrow("window closed");
  expect(count).toBe(1);
  expect(f.events).toEqual([]);
});
test("abort prevents starting a targeted native operation", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.adapter.accessibility!.input(
      f.state,
      { action: "drag", from: { x: 110, y: 100 }, to: { x: 120, y: 110 } },
      controller.signal,
    ),
  ).rejects.toBeDefined();
  expect(f.events).toEqual([]);
});
test("launch completion still observes cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.host.openApplication = async () => {
    controller.abort();
  };
  await expect(
    f.adapter.input({ action: "open", app: "TextEdit" }, controller.signal),
  ).rejects.toBeDefined();
});

test("opening an app cannot bypass a takeover not yet returned by the native helper", async () => {
  const f = fixture();
  f.host.accessibility.checkOwnership = async () => {
    throw new ComputerError("user_interrupted", "User took over");
  };
  await expect(
    f.adapter.input({ action: "open", app: "TextEdit" }, f.signal),
  ).rejects.toMatchObject({
    code: "user_interrupted",
    applied: "no",
  });
  expect(f.events).toEqual([]);
});
