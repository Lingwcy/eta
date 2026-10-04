import { afterEach, expect, test, vi } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";
import { persistTabs, readTabs, restoreTabs } from "./tab-storage";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("draft edits are batched and pagehide flushes the current selection for restoration", () => {
  vi.useFakeTimers();
  let id = 0;
  const tabs = new DesktopTabs(() => `tab-${++id}`);
  const storage = new Map<string, string>();
  const writes = vi.fn((key: string, value: string) => storage.set(key, value));
  const target = new EventTarget();
  const dispose = persistTabs(tabs, { setItem: writes }, target);
  tabs.updateConversation(tabs.activeTab.id, { workspaceId: "project", draft: "First edit" });
  tabs.updateConversation(tabs.activeTab.id, { draft: "Second edit" });
  vi.advanceTimersByTime(249);
  expect(writes).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(writes).toHaveBeenCalledOnce();
  tabs.newBrowser("https://example.com/");
  target.dispatchEvent(new Event("pagehide"));
  const saved = readTabs({ getItem: (key) => storage.get(key) ?? null });
  const restored = new DesktopTabs(undefined, saved);
  expect(restored.activeTab).toMatchObject({ kind: "browser", url: "https://example.com/" });
  expect(restored.getSnapshot().tabs[0]).toMatchObject({
    draft: "Second edit",
    workspaceId: "project",
  });
  dispose();
  const count = writes.mock.calls.length;
  tabs.newConversation();
  vi.advanceTimersByTime(1000);
  target.dispatchEvent(new Event("pagehide"));
  expect(writes.mock.calls.length).toBe(count);
});

test("storage failures leave the active session usable and record their cause", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(readTabs({ getItem: () => "broken json" })).toBeUndefined();
  const tabs = new DesktopTabs();
  const failure = new Error("Storage quota exceeded");
  const dispose = persistTabs(
    tabs,
    {
      setItem: () => {
        throw failure;
      },
    },
    new EventTarget(),
  );
  tabs.updateConversation(tabs.activeTab.id, { draft: "Still available" });
  dispose();
  expect(tabs.activeTab).toMatchObject({ draft: "Still available" });
  expect(warn).toHaveBeenCalledWith("Unable to save desktop tabs", failure);
});

test("restoration drops malformed URLs without silently truncating a user's open sessions", () => {
  const saved = restoreTabs({
    version: 1,
    activeId: "broken",
    tabs: [
      { id: "broken", kind: "browser", url: "https://" },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `chat-${index}`,
        kind: "conversation",
        workspaceId: null,
        draft: "",
      })),
    ],
  });
  expect(saved?.tabs).toHaveLength(61);
  expect(saved?.tabs[0]).toMatchObject({ url: "" });
});

test("restoration rejects corrupt records, duplicate identities and executable page URLs", () => {
  expect(restoreTabs({ version: 2, tabs: [] })).toBeUndefined();
  const restored = restoreTabs({
    version: 1,
    activeId: "missing",
    tabs: [
      {
        id: "one",
        kind: "conversation",
        workspaceId: "workspace",
        threadId: "thread",
        draft: "Saved",
      },
      {
        id: "duplicate-thread",
        kind: "conversation",
        workspaceId: "workspace",
        threadId: "thread",
      },
      { id: "one", kind: "browser", url: "https://example.com/" },
      { id: "unsafe", kind: "browser", url: "javascript:alert(1)" },
      { id: "settings-one", kind: "settings" },
      { id: "settings-two", kind: "settings" },
      { id: "wrong", kind: "conversation", workspaceId: 42 },
    ],
  });
  expect(restored?.activeId).toBe("one");
  expect(restored?.tabs.map((tab) => tab.id)).toEqual(["one", "unsafe", "settings-one"]);
  expect(restored?.tabs[1]).toMatchObject({ url: "" });
  expect(new DesktopTabs(() => "fresh", restored).getSnapshot().tabs[0]).toMatchObject({
    draft: "Saved",
  });
});
