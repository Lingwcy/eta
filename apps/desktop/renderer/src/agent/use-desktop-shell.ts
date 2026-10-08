import { useSubagents } from "./use-subagents";
import { inspectedConversation } from "./inspector";
import { useCallback, useState } from "react";
import { useDesktopLibrary } from "./use-desktop-library";
import { useDesktopTabs } from "./use-desktop-tabs";
import { useDesktopShortcuts } from "./use-desktop-shortcuts";
import { useTabPresentations } from "./use-tab-presentations";
import { useBrowserPages } from "@/browser/use-browser-pages";

export function useDesktopShell() {
  const desktop = useDesktopLibrary();
  const navigation = useDesktopTabs(desktop.library);
  const [selectedSubagents, setSelectedSubagents] = useState<Record<string, string | undefined>>(
    {},
  );
  const selectSubagent = (threadId: string, path?: string) =>
    setSelectedSubagents((current) => ({ ...current, [threadId]: path }));
  const [version, setVersion] = useState(0);
  const inspectorConversation = inspectedConversation(navigation.state);
  const subagents = useSubagents(inspectorConversation?.threadId, version);
  const inspectorAvailable = subagents.length > 0;
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const inspectorOpen = inspectorAvailable && inspectorExpanded;
  const toggleInspector = useCallback(() => {
    if (inspectorAvailable) setInspectorExpanded((value) => !value);
  }, [inspectorAvailable]);
  const [collapsed, setCollapsed] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [threadOverlay, setThreadOverlay] = useState(false);
  const toggleSidebar = useCallback(() => setCollapsed((value) => !value), []);
  const runShortcut = useDesktopShortcuts(navigation.tabs, toggleSidebar, toggleInspector);
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
    selectedSubagents,
    selectSubagent,
    inspectorConversation,
    subagents,
    inspectorAvailable,
    inspectorOpen,
    toggleInspector,
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
