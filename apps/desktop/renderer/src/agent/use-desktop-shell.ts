import { useCallback, useState } from "react";
import { useDesktopLibrary } from "./use-desktop-library";
import { useDesktopTabs } from "./use-desktop-tabs";
import { useDesktopShortcuts } from "./use-desktop-shortcuts";
import { useTabPresentations } from "./use-tab-presentations";
import { useBrowserPages } from "@/browser/use-browser-pages";

export function useDesktopShell() {
  const desktop = useDesktopLibrary();
  const navigation = useDesktopTabs(desktop.library);
  const [collapsed, setCollapsed] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [threadOverlay, setThreadOverlay] = useState(false);
  const [version, setVersion] = useState(0);
  const toggleSidebar = useCallback(() => setCollapsed((value) => !value), []);
  const runShortcut = useDesktopShortcuts(navigation.tabs, toggleSidebar);
  const browser = useBrowserPages(navigation.tabs, navigation.state, runShortcut);
  const { items, savePreview } = useTabPresentations(navigation, desktop.library, browser.pages);
  const chooseProject = () =>
    void desktop.act(async () => {
      const project = await window.eta.chooseProject();
      if (!project) return;
      const library = await desktop.refresh();
      navigation.tabs.newConversation(
        library.workspaces.find((workspace) => workspace.projectId === project.id)?.id ?? null,
      );
    });
  const selectThread = (id: string) => {
    const thread = desktop.library?.threads.find((thread) => thread.id === id);
    if (thread) navigation.tabs.openThread(thread.id, thread.workspaceId);
  };
  const reconnect = () => setVersion((value) => value + 1);
  const refreshSettings = async () => {
    await desktop.refresh();
    reconnect();
  };
  return {
    desktop,
    navigation,
    browser,
    items,
    savePreview,
    collapsed,
    overlay: overlay || threadOverlay,
    version,
    toggleSidebar,
    setOverlay,
    setThreadOverlay,
    chooseProject,
    selectThread,
    reconnect,
    refreshSettings,
    expandSidebar: () => setCollapsed(false),
  };
}

export type DesktopShell = ReturnType<typeof useDesktopShell>;
