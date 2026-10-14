import { expect, test } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";
import { ThreadRecents } from "./thread-recents";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("opening, selecting, reopening and focusing leave input priority unchanged", () => {
  let now = 100;
  const tabs = new DesktopTabs();
  const target = new EventTarget();
  const recents = new ThreadRecents(storage(), () => now);
  const disconnect = recents.connect(target);
  recents.recordInput("first");
  now = 200;
  recents.recordInput("second");
  const before = recents.getSnapshot();
  const first = tabs.openThread("first", "root");
  const second = tabs.openThread("second", "tree");
  tabs.updateConversation(first, { draft: "unsent draft" });
  tabs.select(first);
  tabs.navigate(-1);
  tabs.close(second);
  tabs.reopen();
  target.dispatchEvent(new Event("focus"));
  expect(recents.getSnapshot()).toBe(before);
  now = 300;
  recents.recordInput("first");
  expect(recents.getSnapshot()[0]).toEqual({ threadId: "first", visitedAt: 300 });
  disconnect();
});

test("restoration and another window preserve newer inputs and deterministic same-time ordering", () => {
  const saved = storage();
  const first = new ThreadRecents(saved, () => 100);
  const second = new ThreadRecents(saved, () => 200);
  first.recordInput("local-thread");
  second.recordInput("bot:host:cloud-thread");
  first.recordInput("another-thread");
  expect(new ThreadRecents(saved).getSnapshot().map((visit) => visit.threadId)).toEqual([
    "bot:host:cloud-thread",
    "another-thread",
    "local-thread",
  ]);
  const tied = new ThreadRecents(saved, () => 200);
  tied.recordInput("last-click");
  expect(tied.getSnapshot()[0].threadId).toBe("last-click");
});

test("invalid or unavailable storage does not prevent recording inputs", () => {
  const saved = {
    getItem: () => "{invalid",
    setItem: () => {
      throw new Error("Unavailable");
    },
  };
  const recents = new ThreadRecents(saved, () => 100);
  expect(recents.getSnapshot()).toEqual([]);
  recents.recordInput("thread");
  expect(recents.getSnapshot()).toEqual([{ threadId: "thread", visitedAt: 100 }]);
});
