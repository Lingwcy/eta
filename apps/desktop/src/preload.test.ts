import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { AgentEvent, DesktopBridge } from "./bridge.ts";

const transport = vi.hoisted(() => ({
  invoke: vi.fn(),
  send: vi.fn(),
  events: new Set<(event: unknown, payload: unknown) => void>(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: transport.expose },
  ipcRenderer: {
    invoke: transport.invoke,
    send: transport.send,
    on: (_name: string, listener: (event: unknown, payload: unknown) => void) => {
      transport.events.add(listener);
    },
    removeListener: (_name: string, listener: (event: unknown, payload: unknown) => void) => {
      transport.events.delete(listener);
    },
  },
}));
let bridge: DesktopBridge;
beforeEach(async () => {
  vi.resetModules();
  transport.events.clear();
  transport.send.mockClear();
  transport.expose.mockClear();
  await import("./preload.ts");
  bridge = transport.expose.mock.calls[0]![1] as DesktopBridge;
});
test("independent subscriptions survive another listener unsubscribing, and ignore old epochs", () => {
  const first: AgentEvent[] = [];
  const second: AgentEvent[] = [];
  const off1 = bridge.subscribe("thread", (event) => first.push(event));
  const off2 = bridge.subscribe("thread", (event) => second.push(event));
  const token1 = transport.send.mock.calls[0]![2];
  const token2 = transport.send.mock.calls[1]![2];
  expect(token1).not.toBe(token2);
  const event: AgentEvent = { type: "error", message: "current event" };
  const emit = (subscriptionId: unknown) => {
    for (const listener of transport.events)
      listener({}, { sessionId: "thread", subscriptionId, event });
  };
  emit(token1);
  expect(first).toEqual([event]);
  expect(second).toEqual([]);
  off1();
  emit(token1);
  emit(token2);
  expect(first).toEqual([event]);
  expect(second).toEqual([event]);
  expect(transport.send.mock.calls.at(-1)).toEqual(["agent:unwatch", token1]);
  off2();
  expect(transport.events.size).toBe(0);
});

test("invoke decodes success values and preserves domain error metadata", async () => {
  transport.invoke.mockResolvedValueOnce({ ok: true, value: { id: "thread" } });
  await expect(bridge.openThread("thread")).resolves.toEqual({ id: "thread" });
  transport.invoke.mockResolvedValueOnce({
    ok: false,
    error: { code: "Busy", message: "Workspace busy", retryable: true },
  });
  await expect(bridge.submit("thread", "Hello")).rejects.toMatchObject({
    code: "Busy",
    retryable: true,
    message: "Workspace busy",
  });
});
