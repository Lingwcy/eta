import type { DesktopTabState, ConversationTab } from "./desktop-tabs";
import type { DesktopLibrary } from "../../../src/bridge.ts";

/** Settings and browser tabs keep the most recently viewed, still-open conversation in the inspector. */
export function inspectedConversation(state: DesktopTabState): ConversationTab | undefined {
  for (const id of state.history.slice(0, state.historyIndex + 1).reverse()) {
    const tab = state.tabs.find((tab) => tab.id === id);
    if (tab?.kind === "conversation") return tab;
  }
}

/** A thread's execution workspace wins over its mutable display grouping and any stale tab binding. */
export function inspectedWorkspace(
  conversation: ConversationTab | undefined,
  library:
    | (Pick<DesktopLibrary, "workspaces"> & {
        readonly threads: readonly { id: string; workspaceId: string }[];
      })
    | null,
) {
  const id = conversation?.threadId
    ? library?.threads.find((thread) => thread.id === conversation.threadId)?.workspaceId
    : conversation?.workspaceId;
  return library?.workspaces.find((workspace) => workspace.id === id);
}
