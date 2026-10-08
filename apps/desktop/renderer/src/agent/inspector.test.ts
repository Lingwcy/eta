import { expect, test } from "vite-plus/test";
import { DesktopTabs } from "./desktop-tabs";
import { inspectedConversation } from "./inspector";

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
