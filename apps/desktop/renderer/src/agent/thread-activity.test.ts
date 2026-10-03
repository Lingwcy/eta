import { expect, test, vi } from "vite-plus/test";
import type { AgentEvent } from "../../../src/bridge.ts";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";
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

test("a lost observation removes stale indicators and releases its subscription", () => {
  const { activity, listeners, unsubscribed } = fixture();
  activity.watch("thread");
  listeners.get("thread")?.({ type: "error", message: "Disconnected" });
  expect(activity.getSnapshot().size).toBe(0);
  expect(unsubscribed).toEqual(["thread"]);
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
