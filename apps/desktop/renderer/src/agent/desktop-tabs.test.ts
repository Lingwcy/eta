import { expect, test } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";

function setup() {
  let id = 0;
  return new DesktopTabs(() => `tab-${++id}`);
}

test("skill management reuses the settings tab and restores its destination after closing and reopening", () => {
  const tabs = setup();
  const conversation = tabs.activeTab.id;
  tabs.openSettings();
  const settings = tabs.activeTab.id;
  tabs.select(conversation);
  tabs.openSettings("skills");
  expect(tabs.activeTab).toMatchObject({ id: settings, kind: "settings", category: "skills" });
  expect(tabs.getSnapshot().tabs).toHaveLength(2);
  tabs.close(settings);
  tabs.reopen();
  expect(tabs.activeTab).toMatchObject({ id: settings, category: "skills" });
});

test("new chat reuses the active draft without changing its state", () => {
  const tabs = setup();
  const id = tabs.activeTab.id;
  tabs.updateConversation(id, { workspaceId: "workspace", draft: "Keep this draft" });
  const before = tabs.getSnapshot();
  expect(tabs.newConversation()).toBe(id);
  expect(tabs.getSnapshot()).toBe(before);
});

test.each(["browser", "settings", "thread"] as const)(
  "new chat from %s focuses the existing draft and preserves its content",
  (kind) => {
    const tabs = setup();
    const draft = tabs.activeTab.id;
    tabs.updateConversation(draft, { workspaceId: "workspace", draft: "Unsent work" });
    if (kind === "browser") tabs.newBrowser();
    else if (kind === "settings") tabs.openSettings();
    else tabs.openThread("saved", "workspace");
    const count = tabs.getSnapshot().tabs.length;
    expect(tabs.newConversation()).toBe(draft);
    expect(tabs.activeTab).toMatchObject({ draft: "Unsent work", workspaceId: "workspace" });
    expect(tabs.getSnapshot().tabs).toHaveLength(count);
    const selected = tabs.getSnapshot();
    tabs.newConversation();
    expect(tabs.getSnapshot()).toBe(selected);
  },
);

test("a submitted draft allows one new chat, and closing it allows another", () => {
  const tabs = setup();
  const submitted = tabs.activeTab.id;
  tabs.updateConversation(submitted, { threadId: "admitted", workspaceId: "workspace" });
  const fresh = tabs.newConversation();
  expect(fresh).not.toBe(submitted);
  expect(tabs.newConversation()).toBe(fresh);
  tabs.close(fresh);
  const replacement = tabs.newConversation();
  expect(replacement).not.toBe(fresh);
  expect(tabs.getSnapshot().tabs).toHaveLength(2);
});

test("choosing a project reuses its draft without replacing another project's work", () => {
  const tabs = setup();
  const first = tabs.newConversation("one");
  tabs.updateConversation(first, { draft: "First project" });
  const second = tabs.newConversation("two");
  expect(tabs.newConversation("one")).toBe(first);
  expect(tabs.activeTab).toMatchObject({ workspaceId: "one", draft: "First project" });
  tabs.select(second);
  expect(tabs.newConversation()).toBe(second);
});

test("conversation drafts and project selection survive switching, closing and reopening", () => {
  const tabs = setup();
  const first = tabs.getSnapshot().activeId;
  tabs.updateConversation(first, { workspaceId: "project-one", draft: "Unsent work" });
  const second = tabs.newConversation("project-two");
  tabs.updateConversation(second, { draft: "Other work" });
  tabs.select(first);
  tabs.close(first);
  expect(tabs.getSnapshot().activeId).toBe(second);
  expect(tabs.getSnapshot().tabs[0]).toMatchObject({
    workspaceId: "project-two",
    draft: "Other work",
  });
  tabs.reopen();
  expect(tabs.getSnapshot().activeId).toBe(first);
  expect(tabs.getSnapshot().tabs.find((tab) => tab.id === first)).toMatchObject({
    workspaceId: "project-one",
    draft: "Unsent work",
  });
});

test("opening a saved thread and settings repeatedly focuses their existing tabs", () => {
  const tabs = setup();
  const thread = tabs.openThread("durable", "workspace");
  tabs.newBrowser("https://example.com/");
  expect(tabs.openThread("durable", "workspace")).toBe(thread);
  tabs.openSettings();
  const settings = tabs.getSnapshot().activeId;
  tabs.select(thread);
  tabs.openSettings();
  expect(tabs.getSnapshot().activeId).toBe(settings);
  expect(tabs.getSnapshot().tabs.filter((tab) => tab.kind === "settings")).toHaveLength(1);
  expect(tabs.getSnapshot().tabs.filter((tab) => tab.kind === "conversation")).toHaveLength(1);
});

test("a late admission binds a closed draft without changing the selected view", () => {
  const tabs = setup();
  const draft = tabs.getSnapshot().activeId;
  const web = tabs.newBrowser("https://example.com/");
  tabs.close(draft);
  tabs.updateConversation(draft, { threadId: "admitted", workspaceId: "original-project" });
  expect(tabs.getSnapshot().activeId).toBe(web);
  tabs.reopen();
  expect(tabs.getSnapshot().tabs.find((tab) => tab.id === draft)).toMatchObject({
    threadId: "admitted",
    workspaceId: "original-project",
  });
});

test("closing a background tab retains selection; closing the last tab opens a new conversation", () => {
  const tabs = setup();
  const first = tabs.getSnapshot().activeId;
  const second = tabs.newBrowser("https://example.com/");
  tabs.close(first);
  expect(tabs.getSnapshot().activeId).toBe(second);
  tabs.close(second);
  expect(tabs.getSnapshot().tabs).toEqual([
    { id: "tab-3", kind: "conversation", workspaceId: null, draft: "" },
  ]);
  tabs.reopen();
  expect(tabs.getSnapshot().activeId).toBe(second);
  expect(tabs.getSnapshot().tabs.find((tab) => tab.id === second)).toMatchObject({
    url: "https://example.com/",
  });
});

test.each(["conversation", "settings"] as const)(
  "closing the final %s tab returns to a fresh conversation and can be reversed",
  (kind) => {
    const tabs = setup();
    const initial = tabs.getSnapshot().activeId;
    if (kind === "settings") {
      tabs.openSettings();
      tabs.close(initial);
    } else tabs.updateConversation(initial, { draft: "Unsent work", workspaceId: "workspace" });
    const closedId = tabs.getSnapshot().activeId;
    tabs.close(closedId);
    const fresh = tabs.getSnapshot().activeId;
    expect(fresh).not.toBe(closedId);
    expect(tabs.getSnapshot().tabs).toEqual([
      { id: fresh, kind: "conversation", workspaceId: null, draft: "" },
    ]);
    tabs.reopen();
    expect(tabs.getSnapshot().activeId).toBe(closedId);
    expect(tabs.getSnapshot().tabs.find((tab) => tab.id === closedId)).toMatchObject(
      kind === "conversation" ? { draft: "Unsent work", workspaceId: "workspace" } : { kind },
    );
  },
);

test("navigation truncates the forward path when a different tab is selected", () => {
  const tabs = setup();
  const first = tabs.getSnapshot().activeId;
  const second = tabs.newBrowser();
  tabs.openSettings();
  const settings = tabs.getSnapshot().activeId;
  tabs.navigate(-1);
  expect(tabs.getSnapshot().activeId).toBe(second);
  tabs.select(first);
  tabs.navigate(1);
  expect(tabs.getSnapshot().activeId).toBe(first);
  expect(tabs.getSnapshot().history).not.toContain(settings);
  tabs.close(second);
  tabs.navigate(-1);
  expect(tabs.getSnapshot().tabs.some((tab) => tab.id === tabs.getSnapshot().activeId)).toBe(true);
});

test("reordering and cycling preserve tab identity and draft contents", () => {
  const tabs = setup();
  const first = tabs.getSnapshot().activeId;
  tabs.updateConversation(first, { draft: "Keep me" });
  const second = tabs.newBrowser();
  tabs.move(second, first);
  expect(tabs.getSnapshot().tabs.map((tab) => tab.id)).toEqual([second, first]);
  expect(tabs.getSnapshot().activeId).toBe(second);
  tabs.cycle(-1);
  expect(tabs.getSnapshot().activeId).toBe(first);
  expect(tabs.getSnapshot().tabs[1]).toMatchObject({ draft: "Keep me" });
});

test("reopening a closed thread does not duplicate a thread already opened from history", () => {
  const tabs = setup();
  const id = tabs.openThread("thread", "workspace");
  tabs.close(id);
  const reopened = tabs.openThread("thread", "workspace");
  tabs.reopen();
  expect(tabs.getSnapshot().activeId).toBe(reopened);
  expect(
    tabs
      .getSnapshot()
      .tabs.filter((tab) => tab.kind === "conversation" && tab.threadId === "thread"),
  ).toHaveLength(1);
});

test("catalog removal clears open and closed tabs so a deleted thread cannot be reopened", () => {
  const tabs = setup();
  const gone = tabs.openThread("gone", "workspace");
  tabs.updateConversation(gone, { draft: "old draft" });
  const kept = tabs.openThread("kept", "workspace");
  tabs.close(gone);
  tabs.reconcileThreads([{ id: "kept", workspaceId: "workspace" }]);
  tabs.reopen();
  expect(tabs.getSnapshot().activeId).toBe(kept);
  tabs.reconcileThreads([]);
  expect(tabs.getSnapshot().closed).toEqual([]);
  expect(tabs.getSnapshot().tabs).toHaveLength(1);
  expect(tabs.activeTab).toMatchObject({ kind: "conversation", workspaceId: null, draft: "" });
});

test("a draft switches execution environments even before a project is selected", () => {
  const tabs = new DesktopTabs();
  const id = tabs.activeTab.id;
  tabs.updateConversation(id, { environment: "cloud", workspaceId: null });
  expect(tabs.activeTab).toMatchObject({ environment: "cloud", workspaceId: null });
  tabs.updateConversation(id, { environment: "local", workspaceId: null });
  expect(tabs.activeTab).toMatchObject({ environment: "local", workspaceId: null });
});
