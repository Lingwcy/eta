import { projectRootWorkspace } from "@/desktop/selectors";
import { useSubagents } from "./use-subagents";
import { inspectedConversation, inspectedWorkspace } from "./inspector";
import { useCallback, useState, useEffect } from "react";
import { useProjectGit } from "./use-project-git";
import { GitHubClient } from "./github-client";
import { isCloudId } from "../../../src/shared/bot.ts";
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
  const contextWorkspace = inspectedWorkspace(inspectorConversation, desktop.library);
  const project = desktop.library?.projects.find(
    (value) => value.id === contextWorkspace?.projectId,
  );
  const root = project && projectRootWorkspace(desktop.library?.workspaces ?? [], project.id);
  const remote = isCloudId(project?.id);
  const connected = !remote || desktop.library?.bot?.status === "connected";
  const [githubClient] = useState(() => new GitHubClient(window.eta));
  const [remoteRequests] = useState(() => new Map<string, string>());
  const projectGit = useProjectGit(
    root?.id,
    connected && (!remote || Boolean(desktop.library?.bot?.capabilities?.includes("git"))),
    version,
  );
  const githubSupported =
    !remote || Boolean(desktop.library?.bot?.capabilities?.includes("github"));
  const githubAvailable =
    githubSupported && projectGit.info?.status === "ready" && Boolean(projectGit.info.github);
  const [inspectorContent, setInspectorContent] = useState<"subagents" | "github">("subagents");
  const inspectorAvailable = subagents.length > 0 || githubAvailable;
  const [inspectorExpanded, setInspectorExpanded] = useState(true);
  const inspectorOpen = inspectorAvailable && inspectorExpanded;
  useEffect(() => {
    githubClient.clear();
  }, [githubClient, desktop.library?.bot?.url, desktop.library?.bot?.status]);
  const selectInspectorContent = (next: "github" | "subagents") => {
    if (next === "github" ? !githubAvailable : !subagents.length) return;
    setInspectorContent(next);
  };
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
        projectRootWorkspace(library.workspaces, project.id)?.id ?? null,
      );
    });
  const selectThread = (id: string) => {
    const thread = desktop.library?.threads.find((thread) => thread.id === id);
    if (thread) navigation.tabs.openThread(thread.id, thread.workspaceId);
  };
  const reconnect = () => {
    githubClient.clear();
    setVersion((value) => value + 1);
  };
  const refreshAuthentication = async () => {
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
    contextWorkspace,
    subagents,
    inspectorAvailable,
    inspectorOpen,
    toggleInspector,
    inspectorContent,
    selectInspectorContent,
    github: {
      client: githubClient,
      project,
      info: projectGit.info,
      available: githubAvailable,
      connected,
      refresh: () => {
        void projectGit.refresh();
      },
      selectRemote: async (name: string) => {
        if (!project) return;
        const key = JSON.stringify([project.id, name]);
        const requestId = remoteRequests.get(key) ?? crypto.randomUUID();
        remoteRequests.set(key, requestId);
        await desktop.act(async () => {
          await window.eta.selectGitHubRemote(project.id, name, requestId);
          remoteRequests.delete(key);
          githubClient.clear();
          await projectGit.refresh();
        });
      },
    },
    collapsed,
    overlay: overlay || threadOverlay,
    version,
    toggleSidebar,
    setOverlay,
    setThreadOverlay,
    chooseProject,
    selectThread,
    reconnect,
    refreshAuthentication,
    expandSidebar: () => setCollapsed(false),
  };
}

export type DesktopShell = ReturnType<typeof useDesktopShell>;
