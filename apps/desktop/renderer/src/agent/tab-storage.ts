import type { DesktopTab, DesktopTabState, DesktopTabs } from "./desktop-tabs";

const STORAGE_KEY = "eta.desktop-tabs.v1";
type SavedTabs = Pick<DesktopTabState, "tabs" | "activeId">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTab(value: unknown): DesktopTab | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) return;
  switch (value.kind) {
    case "conversation": {
      if (value.workspaceId !== null && typeof value.workspaceId !== "string") return;
      return {
        id: value.id,
        kind: value.kind,
        workspaceId: value.workspaceId,
        threadId: typeof value.threadId === "string" ? value.threadId : undefined,
        draft: typeof value.draft === "string" ? value.draft : "",
      };
    }
    case "browser": {
      if (typeof value.url !== "string") return;
      const url = URL.canParse(value.url) && /^https?:\/\//i.test(value.url) ? value.url : "";
      return {
        id: value.id,
        kind: value.kind,
        url,
        title: typeof value.title === "string" ? value.title : "新标签页",
      };
    }
    case "settings":
      return { id: value.id, kind: value.kind };
  }
}

/** Persisted data is validated here; the tab model only accepts valid state. */
export function restoreTabs(raw: unknown): SavedTabs | undefined {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.tabs)) return;
  const tabs: DesktopTab[] = [];
  const identities = new Set<string>();
  for (const value of raw.tabs as unknown[]) {
    const tab = readTab(value);
    if (!tab) continue;
    const identity =
      tab.kind === "settings"
        ? "settings"
        : tab.kind === "conversation" && tab.threadId
          ? `thread:${tab.threadId}`
          : `tab:${tab.id}`;
    if (identities.has(identity) || tabs.some((open) => open.id === tab.id)) continue;
    identities.add(identity);
    tabs.push(tab);
  }
  if (!tabs.length) return;
  return {
    tabs,
    activeId: tabs.find((tab) => tab.id === raw.activeId)?.id ?? tabs[0]!.id,
  };
}

export function readTabs(storage: Pick<Storage, "getItem">): SavedTabs | undefined {
  try {
    return restoreTabs(JSON.parse(storage.getItem(STORAGE_KEY) ?? "null"));
  } catch (error) {
    console.warn("Unable to restore desktop tabs", error);
  }
}

/** Batch draft edits, and flush the latest selection before the renderer leaves. */
export function persistTabs(
  tabs: DesktopTabs,
  storage: Pick<Storage, "setItem">,
  target: EventTarget,
) {
  let pending: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(pending);
    const { tabs: open, activeId } = tabs.getSnapshot();
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tabs: open, activeId }));
    } catch (error) {
      console.warn("Unable to save desktop tabs", error);
    }
  };
  const unsubscribe = tabs.subscribe(() => {
    clearTimeout(pending);
    pending = setTimeout(save, 250);
  });
  target.addEventListener("pagehide", save);
  return () => {
    unsubscribe();
    target.removeEventListener("pagehide", save);
    save();
  };
}
