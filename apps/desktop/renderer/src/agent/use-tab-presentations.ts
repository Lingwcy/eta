import { useCallback, useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { BrowserViewState } from "@/browser/client";
import type { DesktopTabController } from "./use-desktop-tabs";
import { presentTab } from "./tab-presentations";

export function useTabPresentations(
  navigation: DesktopTabController,
  library: DesktopLibrary | null,
  pages: Readonly<Record<string, BrowserViewState>>,
) {
  const { tabs, state, runningThreadIds } = navigation;
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const savePreview = useCallback((id: string, text: string) => {
    setPreviews((current) => (current[id] === text ? current : { ...current, [id]: text }));
  }, []);
  useEffect(() => {
    const { tabs: open, closed } = tabs.getSnapshot();
    const retained = new Set([...open, ...closed].map((tab) => tab.id));
    setPreviews((current) => {
      const entries = Object.entries(current).filter(([id]) => retained.has(id));
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [tabs, state.closed]);
  return {
    items: state.tabs.map((tab) =>
      presentTab(tab, library, pages[tab.id], previews[tab.id], runningThreadIds),
    ),
    savePreview,
  };
}
