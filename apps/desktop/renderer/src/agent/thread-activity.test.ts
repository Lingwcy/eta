import { expect, test, vi } from "vite-plus/test";
import type { AgentEvent } from "../../../src/bridge.ts";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { hasThreadActivity, ThreadActivity } from "./thread-activity";

function snapshot(patch: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "off" },
    transcript: [],
    operation: null,
    lastResult: null,
    faulted: false,
    ...patch,
  };
}
const active = snapshot({
  operation: {
    id: "run",
    kind: "run",
    startedAt: 1,
    status: "running",
    fromTipId: null,
    runningTools: [],
  },
});

function fixture() {
  const listeners = new Map<string, (event: AgentEvent) => void>();
  const unsubscribed: string[] = [];
  const subscribe = vi.fn((id: string, listener: (event: AgentEvent) => void) => {
    listeners.set(id, listener);
    return () => {
      unsubscribed.push(id);
    };
  });
  const activity = new ThreadActivity({ subscribe });
  const emit = (id: string, value: AgentSnapshot) =>
    listeners.get(id)?.({ type: "snapshot", value: { snapshot: value, contextTokens: 0 } });
  return { activity, subscribe, listeners, unsubscribed, emit };
}

test("tracks concurrent tasks independently until their completion events arrive", () => {
  const { activity, emit, unsubscribed } = fixture();
  activity.watch("first");
  activity.watch("second");
  emit("first", active);
  emit("second", active);
  expect([...activity.getSnapshot()]).toEqual(["first", "second"]);
  emit("first", snapshot());
  expect([...activity.getSnapshot()]).toEqual(["second"]);
  emit("second", snapshot());
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribed).toEqual(["first", "second"]);
});

test("streaming revisions do not re-render the activity list or duplicate watchers", () => {
  const { activity, subscribe, emit } = fixture();
  const changed = vi.fn();
  activity.subscribe(changed);
  activity.watch("thread");
  const initial = activity.getSnapshot();
  activity.watch("thread");
  emit("thread", active);
  emit("thread", active);
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(activity.getSnapshot()).toBe(initial);
  expect(changed).toHaveBeenCalledTimes(1);
});

test("compaction is active, while interrupted recovery and faults are not running", () => {
  expect(hasThreadActivity(snapshot({ compacting: true }))).toBe(true);
  expect(hasThreadActivity({ ...active, recoveryRequired: true })).toBe(false);
  expect(hasThreadActivity({ ...active, faulted: true })).toBe(false);
  expect(hasThreadActivity(snapshot())).toBe(false);
});

test("keeps watching an idle root until background children and their final synthesis finish", () => {
  const { activity, emit, unsubscribed } = fixture();
  activity.watch("thread");
  const child = {
    path: "/worker",
    parent: "/root",
    conversationId: 2,
    fork: false,
    depth: 1,
    status: "running" as const,
  };
  emit("thread", snapshot({ subagents: [child] }));
  expect(activity.getSnapshot().has("thread")).toBe(true);
  expect(unsubscribed).toEqual([]);
  emit("thread", { ...active, subagents: [{ ...child, status: "completed" }] });
  expect(activity.getSnapshot().has("thread")).toBe(true);
  emit("thread", snapshot({ subagents: [{ ...child, status: "completed" }] }));
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribed).toEqual(["thread"]);
});

test("transport errors retain activity and observation until a recovered snapshot confirms completion", () => {
  const { activity, subscribe, emit, listeners, unsubscribed } = fixture();
  const changed = vi.fn();
  activity.subscribe(changed);
  activity.watch("thread");
  emit("thread", active);
  const running = activity.getSnapshot();
  listeners.get("thread")?.({ type: "error", message: "502 Bad Gateway" });
  listeners.get("thread")?.({ type: "error", message: "Disconnected" });
  expect(activity.getSnapshot()).toBe(running);
  expect(unsubscribed).toEqual([]);
  expect(changed).toHaveBeenCalledTimes(1);
  activity.watch("thread");
  expect(subscribe).toHaveBeenCalledTimes(1);
  emit("thread", active);
  expect(activity.getSnapshot()).toBe(running);
  emit("thread", snapshot());
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribed).toEqual(["thread"]);
  expect(changed).toHaveBeenCalledTimes(2);
});

test.each([{ recoveryRequired: true }, { faulted: true }])(
  "a recovered snapshot with %j clears activity even with an interrupted operation",
  (terminal) => {
    const { activity, emit, listeners, unsubscribed } = fixture();
    activity.watch("thread");
    listeners.get("thread")?.({ type: "error", message: "Disconnected" });
    emit("thread", { ...active, ...terminal });
    expect(activity.getSnapshot().size).toBe(0);
    expect(unsubscribed).toEqual(["thread"]);
  },
);

test("disposing after a transport error still releases the retained subscription", () => {
  const { activity, listeners, unsubscribed } = fixture();
  activity.watch("thread");
  const stale = listeners.get("thread");
  stale?.({ type: "error", message: "Disconnected" });
  expect(unsubscribed).toEqual([]);
  activity.dispose();
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribed).toEqual(["thread"]);
  activity.watch("thread");
  stale?.({ type: "error", message: "Disconnected" });
  stale?.({ type: "snapshot", value: { snapshot: snapshot(), contextTokens: 0 } });
  expect(activity.getSnapshot().has("thread")).toBe(true);
  activity.dispose();
});

test("a synchronous transport error keeps the returned observation alive", () => {
  const unsubscribe = vi.fn();
  const activity = new ThreadActivity({
    subscribe: (_id, listener) => {
      listener({ type: "error", message: "Disconnected" });
      return unsubscribe;
    },
  });
  activity.watch("thread");
  expect(activity.getSnapshot().has("thread")).toBe(true);
  expect(unsubscribe).not.toHaveBeenCalled();
  activity.dispose();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("disposed and replaced subscriptions cannot clear a newly running task", () => {
  const { activity, listeners, emit, unsubscribed } = fixture();
  activity.watch("thread");
  const stale = listeners.get("thread");
  activity.dispose();
  expect(activity.getSnapshot().size).toBe(0);
  activity.watch("thread");
  stale?.({ type: "snapshot", value: { snapshot: snapshot(), contextTokens: 0 } });
  expect(activity.getSnapshot().has("thread")).toBe(true);
  emit("thread", snapshot());
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribed).toEqual(["thread", "thread"]);
});

test("a synchronous terminal snapshot still cleans up the returned subscription", () => {
  const unsubscribe = vi.fn();
  const activity = new ThreadActivity({
    subscribe: (_id, listener) => {
      listener({ type: "snapshot", value: { snapshot: snapshot(), contextTokens: 0 } });
      return unsubscribe;
    },
  });
  activity.watch("thread");
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
