import type { DesktopTabState, ConversationTab } from "./desktop-tabs";

/** Settings and browser tabs keep the most recently viewed, still-open conversation in the inspector. */
export function inspectedConversation(state: DesktopTabState): ConversationTab | undefined {
  for (const id of state.history.slice(0, state.historyIndex + 1).reverse()) {
    const tab = state.tabs.find((tab) => tab.id === id);
    if (tab?.kind === "conversation") return tab;
  }
}
