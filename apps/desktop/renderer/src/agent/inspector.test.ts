import { expect, test } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";
import { inspectedConversation, showScheduledTasks } from "./inspector";

function setup() {
  let id = 0;
  return new DesktopTabs(() => `tab-${++id}`);
}

test("inspector follows selected conversations and retains their context in settings and browser tabs", () => {
  const tabs = setup();
  tabs.openThread("first", "workspace");
  const first = tabs.activeTab.id;
  tabs.openThread("second", "workspace");
  tabs.openSettings("subagents");
  expect(inspectedConversation(tabs.getSnapshot())?.threadId).toBe("second");
  tabs.select(first);
  tabs.newBrowser();
  expect(inspectedConversation(tabs.getSnapshot())?.threadId).toBe("first");
  tabs.navigate(-1);
  expect(inspectedConversation(tabs.getSnapshot())?.threadId).toBe("first");
});

test("an empty draft clears old thread context and closing conversations skips stale history", () => {
  const tabs = setup();
  tabs.openThread("saved", "workspace");
  const saved = tabs.activeTab.id;
  tabs.newConversation();
  const draft = tabs.activeTab.id;
  tabs.openSettings();
  expect(inspectedConversation(tabs.getSnapshot())?.threadId).toBeUndefined();
  expect(inspectedConversation(tabs.getSnapshot())?.id).toBe(draft);
  tabs.close(draft);
  expect(inspectedConversation(tabs.getSnapshot())?.threadId).toBe("saved");
  tabs.close(saved);
  expect(inspectedConversation(tabs.getSnapshot())).toBeUndefined();
});

test("GitHub context follows execution workspace rather than thread grouping or a stale tab", async () => {
  const { inspectedWorkspace } = await import("./inspector");
  const tabs = setup();
  tabs.openThread("saved", "stale");
  const library = {
    projects: [],
    workspaces: [
      {
        id: "actual",
        projectId: "execution",
        cwd: "/execution",
        kind: "worktree" as const,
        createdAt: 1,
      },
    ],
    threads: [
      { id: "saved", workspaceId: "actual", projectId: "display", title: "Thread", createdAt: 1 },
    ],
  };
  expect(inspectedWorkspace(inspectedConversation(tabs.getSnapshot()), library)).toMatchObject({
    id: "actual",
    projectId: "execution",
  });
});

test("scheduled-task navigation from settings and browser reuses the latest valid conversation", () => {
  const tabs = setup();
  tabs.openThread("saved", "workspace");
  const conversation = tabs.activeTab.id;
  tabs.openSettings("about");
  const settings = tabs.activeTab.id;
  const count = tabs.getSnapshot().tabs.length;
  showScheduledTasks(tabs);
  expect(tabs.activeTab.id).toBe(conversation);
  expect(tabs.getSnapshot().tabs).toHaveLength(count);
  expect(tabs.getSnapshot().tabs.some((tab) => tab.id === settings)).toBe(true);
  tabs.newBrowser();
  const browser = tabs.activeTab.id;
  showScheduledTasks(tabs);
  expect(tabs.activeTab.id).toBe(conversation);
  expect(tabs.getSnapshot().tabs.some((tab) => tab.id === browser)).toBe(true);
});
test("scheduled-task navigation with no surviving conversation creates a draft rather than reusing a closed thread", () => {
  const tabs = setup();
  tabs.openThread("saved", "workspace");
  tabs.openSettings();
  for (const tab of tabs.getSnapshot().tabs.filter((tab) => tab.kind === "conversation"))
    tabs.close(tab.id);
  showScheduledTasks(tabs);
  expect(tabs.activeTab.kind).toBe("conversation");
  expect(tabs.activeTab).toMatchObject({ draft: "", workspaceId: null });
  expect("threadId" in tabs.activeTab).toBe(false);
});
