import { afterEach, expect, test, vi } from "vite-plus/test";
import { ipcMain } from "electron";
import type { DesktopApplication } from "../bootstrap.ts";
import type { SnapshotResponse } from "@eta/core/agent/protocol";
import { createAgentSubscriptions } from "./subscriptions.ts";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return { ipcMain: new EventEmitter() };
});

afterEach(() => ipcMain.removeAllListeners());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const snapshot: SnapshotResponse = {
  contextTokens: 0,
  snapshot: {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "off" },
    transcript: [],
    operation: null,
    lastResult: null,
    faulted: false,
  },
};

const sender = (id: number) => ({ id, isDestroyed: () => false, send: vi.fn() });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test("unwatch during asynchronous setup cleans the late subscription without delivering snapshots", async () => {
  const pending = deferred<() => void>();
  let observe: Parameters<DesktopApplication["subscribe"]>[1] | undefined;
  const unsubscribe = vi.fn();
  const subscriptions = createAgentSubscriptions(() => ({
    subscribe: async (_id, next) => {
      observe = next;
      return pending.promise;
    },
  }));
  const contents = sender(1);
  ipcMain.emit("agent:watch", { sender: contents }, "thread", "subscription");
  await flush();
  ipcMain.emit("agent:unwatch", { sender: contents }, "subscription");
  observe?.(snapshot);
  pending.resolve(unsubscribe);
  await flush();
  expect(contents.send).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalledOnce();
  subscriptions.dispose();
});

test("reusing a subscription id rejects the previous stream's snapshots and cleanup", async () => {
  const requests: {
    next: Parameters<DesktopApplication["subscribe"]>[1];
    pending: ReturnType<typeof deferred<() => void>>;
  }[] = [];
  const subscriptions = createAgentSubscriptions(() => ({
    subscribe: async (_id, next) => {
      const pending = deferred<() => void>();
      requests.push({ next, pending });
      return pending.promise;
    },
  }));
  const contents = sender(1);
  ipcMain.emit("agent:watch", { sender: contents }, "old-thread", "subscription");
  await flush();
  ipcMain.emit("agent:unwatch", { sender: contents }, "subscription");
  ipcMain.emit("agent:watch", { sender: contents }, "new-thread", "subscription");
  await flush();
  requests[0]!.next(snapshot);
  requests[1]!.next(snapshot);
  expect(contents.send.mock.calls).toEqual([
    [
      "agent:event",
      {
        sessionId: "new-thread",
        subscriptionId: "subscription",
        event: { type: "snapshot", value: snapshot },
      },
    ],
  ]);
  const oldUnsubscribe = vi.fn();
  const newUnsubscribe = vi.fn();
  requests[0]!.pending.resolve(oldUnsubscribe);
  requests[1]!.pending.resolve(newUnsubscribe);
  await flush();
  expect(oldUnsubscribe).toHaveBeenCalledOnce();
  expect(newUnsubscribe).not.toHaveBeenCalled();
  subscriptions.disposeWindow(contents.id);
  expect(newUnsubscribe).toHaveBeenCalledOnce();
  subscriptions.dispose();
});

test("window cleanup leaves other windows' independent subscriptions active", async () => {
  const unsubscribed: string[] = [];
  const streams = new Map<string, Parameters<DesktopApplication["subscribe"]>[1]>();
  const subscriptions = createAgentSubscriptions(() => ({
    subscribe: async (id, next) => {
      streams.set(id, next);
      return () => {
        unsubscribed.push(id);
      };
    },
  }));
  const first = sender(1);
  const second = sender(2);
  ipcMain.emit("agent:watch", { sender: first }, "first", "same-id");
  ipcMain.emit("agent:watch", { sender: second }, "second", "same-id");
  await flush();
  subscriptions.disposeWindow(1);
  streams.get("first")?.(snapshot);
  streams.get("second")?.(snapshot);
  expect(unsubscribed).toEqual(["first"]);
  expect(first.send).not.toHaveBeenCalled();
  expect(second.send).toHaveBeenCalledWith("agent:event", {
    sessionId: "second",
    subscriptionId: "same-id",
    event: { type: "snapshot", value: snapshot },
  });
  subscriptions.dispose();
  expect(unsubscribed).toEqual(["first", "second"]);
});

test("late failure from a cancelled watch cannot tear down its replacement", async () => {
  const pending = deferred<() => void>();
  let replacement: Parameters<DesktopApplication["subscribe"]>[1] | undefined;
  let calls = 0;
  const unsubscribe = vi.fn();
  const subscriptions = createAgentSubscriptions(() => ({
    subscribe: async (_id, next) => {
      if (++calls === 1) return pending.promise;
      replacement = next;
      return unsubscribe;
    },
  }));
  const contents = sender(1);
  ipcMain.emit("agent:watch", { sender: contents }, "old", "subscription");
  await flush();
  ipcMain.emit("agent:unwatch", { sender: contents }, "subscription");
  ipcMain.emit("agent:watch", { sender: contents }, "new", "subscription");
  await flush();
  pending.reject(new Error("Old setup failed"));
  await flush();
  replacement?.(snapshot);
  expect(unsubscribe).not.toHaveBeenCalled();
  expect(contents.send.mock.calls).toEqual([
    [
      "agent:event",
      {
        sessionId: "new",
        subscriptionId: "subscription",
        event: { type: "snapshot", value: snapshot },
      },
    ],
  ]);
  subscriptions.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
