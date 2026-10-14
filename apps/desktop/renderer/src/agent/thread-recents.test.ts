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

test("visits follow selection, keyboard navigation and reopen, not draft or workspace updates", () => {
  let now = 100;
  let id = 0;
  const tabs = new DesktopTabs(() => `tab-${++id}`);
  const recents = new ThreadRecents(storage(), () => now);
  const disconnect = recents.connect(tabs, new EventTarget());
  const first = tabs.openThread("first", "root");
  now = 200;
  const second = tabs.openThread("second", "tree");
  expect(recents.getSnapshot().map((visit) => visit.threadId)).toEqual(["second", "first"]);
  const before = recents.getSnapshot();
  now = 300;
  tabs.updateConversation(first, { draft: "background draft" });
  tabs.updateConversation(second, { workspaceId: "moved" });
  tabs.move(first, second);
  expect(recents.getSnapshot()).toBe(before);
  tabs.select(first);
  expect(recents.getSnapshot()[0]).toEqual({ threadId: "first", visitedAt: 300 });
  now = 400;
  tabs.navigate(-1);
  expect(recents.getSnapshot()[0]).toEqual({ threadId: "second", visitedAt: 400 });
  tabs.close(second);
  now = 500;
  tabs.reopen();
  expect(recents.getSnapshot()[0]).toEqual({ threadId: "second", visitedAt: 500 });
  disconnect();
});

test("restoration and another window preserve newer visits and deterministic same-time ordering", () => {
  const saved = storage();
  const first = new ThreadRecents(saved, () => 100);
  const second = new ThreadRecents(saved, () => 200);
  first.visit("local-thread");
  second.visit("bot:host:cloud-thread");
  first.visit("another-thread");
  expect(new ThreadRecents(saved).getSnapshot().map((visit) => visit.threadId)).toEqual([
    "bot:host:cloud-thread",
    "another-thread",
    "local-thread",
  ]);
  const tied = new ThreadRecents(saved, () => 200);
  tied.visit("last-click");
  expect(tied.getSnapshot()[0].threadId).toBe("last-click");
});

test("invalid or unavailable storage does not prevent recording visits", () => {
  const saved = {
    getItem: () => "{invalid",
    setItem: () => {
      throw new Error("Unavailable");
    },
  };
  const recents = new ThreadRecents(saved, () => 100);
  expect(recents.getSnapshot()).toEqual([]);
  recents.visit("thread");
  expect(recents.getSnapshot()).toEqual([{ threadId: "thread", visitedAt: 100 }]);
});

test("hidden windows do not record background tab changes; returning records the visible chat", () => {
  let now = 100;
  let visible = true;
  const target = new EventTarget();
  const tabs = new DesktopTabs();
  const recents = new ThreadRecents(storage(), () => now);
  const disconnect = recents.connect(tabs, target, () => visible);
  tabs.openThread("first", "root");
  visible = false;
  now = 200;
  tabs.openThread("second", "root");
  expect(recents.getSnapshot()).toEqual([{ threadId: "first", visitedAt: 100 }]);
  visible = true;
  target.dispatchEvent(new Event("focus"));
  expect(recents.getSnapshot()[0]).toEqual({ threadId: "second", visitedAt: 200 });
  disconnect();
  now = 300;
  tabs.openThread("third", "root");
  expect(recents.getSnapshot()[0].threadId).toBe("second");
});
