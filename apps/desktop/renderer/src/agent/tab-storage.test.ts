import { afterEach, expect, test, vi } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";
import { persistTabs, readTabs, restoreTabs } from "./tab-storage";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("restoring a temporary thread preserves projectless inheritance before the catalog loads", () => {
  const restored = restoreTabs({
    version: 1,
    activeId: "temporary-tab",
    tabs: [
      {
        id: "temporary-tab",
        kind: "conversation",
        threadId: "temporary-thread",
        workspaceId: "temporary",
        projectless: true,
        draft: "",
      },
    ],
  });
  const tabs = new DesktopTabs(undefined, restored);
  tabs.newConversation();
  expect(tabs.activeTab).toMatchObject({ workspaceId: null, draft: "" });
});

test("a sandbox-only draft change is saved and restored before its first message", () => {
  vi.useFakeTimers();
  const tabs = new DesktopTabs();
  const storage = new Map<string, string>();
  const dispose = persistTabs(
    tabs,
    { setItem: (key, value) => storage.set(key, value) },
    new EventTarget(),
  );
  tabs.updateConversation(tabs.activeTab.id, { sandboxMode: "read-only" });
  vi.advanceTimersByTime(250);
  const restored = new DesktopTabs(
    undefined,
    readTabs({ getItem: (key) => storage.get(key) ?? null }),
  );
  expect(restored.activeTab).toMatchObject({
    sandboxMode: "read-only",
    workspaceId: null,
    draft: "",
  });
  expect(restored.activeTab).toHaveProperty("threadId", undefined);
  dispose();
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

test("a settings page survives a restart and malformed pages are dropped", () => {
  vi.useFakeTimers();
  try {
    let next = 0;
    const tabs = new DesktopTabs(() => "tab-" + ++next);
    const storage = new Map<string, string>();
    const dispose = persistTabs(
      tabs,
      { setItem: (key, value) => storage.set(key, value) },
      new EventTarget(),
    );
    tabs.openSettings("skills");
    vi.advanceTimersByTime(250);
    const restored = new DesktopTabs(
      undefined,
      readTabs({ getItem: (key) => storage.get(key) ?? null }),
    );
    expect(restored.getSnapshot().tabs.find((tab) => tab.kind === "settings")).toMatchObject({
      category: "skills",
    });
    expect(
      restoreTabs({ version: 1, tabs: [{ id: "s", kind: "settings", category: 7 }], activeId: "s" })
        ?.tabs[0],
    ).not.toHaveProperty("category");
    expect(
      restoreTabs({ version: 1, tabs: [{ id: "s", kind: "settings" }], activeId: "s" })?.tabs[0],
    ).not.toHaveProperty("category");
    dispose();
  } finally {
    vi.useRealTimers();
  }
});

test("restoration keeps view IDs and resource identities separate and reserves only accepted rows", () => {
  const conversation = (id: string, threadId?: string) => ({
    kind: "conversation",
    id,
    workspaceId: null,
    draft: id,
    ...(threadId === undefined ? {} : { threadId }),
  });
  const restored = restoreTabs({
    version: 1,
    activeId: "later",
    tabs: [
      conversation("settings"),
      { kind: "settings", id: "panel", category: "models" },
      conversation("thread:target"),
      conversation("first", "target"),
      conversation("reusable", "target"),
      { kind: "browser", id: "reusable", url: "https://example.com/" },
      conversation("reusable", "other-thread"),
      conversation("later", "other-thread"),
      conversation("__proto__", "constructor"),
    ],
  });
  expect(restored?.tabs.map((tab) => tab.id)).toEqual([
    "settings",
    "panel",
    "thread:target",
    "first",
    "reusable",
    "later",
    "__proto__",
  ]);
  expect(restored?.activeId).toBe("later");
  expect(restored?.tabs.at(-1)).toMatchObject({ threadId: "constructor", draft: "__proto__" });
});

test("a large JSON snapshot retains every ordered session, draft, policy and active selection", () => {
  const tabs = Array.from({ length: 10_000 }, (_, index) => ({
    kind: "conversation",
    id: "tab-" + index,
    workspaceId: "workspace-" + index,
    draft: "draft-" + index,
    sandboxMode: index % 2 ? "read-only" : "workspace-write",
  }));
  const restored = restoreTabs(
    JSON.parse(JSON.stringify({ version: 1, tabs, activeId: "tab-9999" })),
  );
  expect(restored?.tabs).toEqual(tabs);
  expect(restored?.activeId).toBe("tab-9999");
});
