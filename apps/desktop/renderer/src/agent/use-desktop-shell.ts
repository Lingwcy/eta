import { useSchedules } from "./use-schedules";
import { projectRootWorkspace } from "@/desktop/selectors";
import { useSubagents } from "./use-subagents";
import { inspectedConversation, inspectedWorkspace, showScheduledTasks } from "./inspector";
import { useCallback, useState, useEffect, useRef } from "react";
import { useProjectGit } from "./use-project-git";
import { GitHubClient } from "./github-client";
import { isCloudId } from "../../../src/shared/bot.ts";
import { useDesktopLibrary } from "./use-desktop-library";
import { useDesktopTabs } from "./use-desktop-tabs";
import { useDesktopShortcuts } from "./use-desktop-shortcuts";
import { useTabPresentations } from "./use-tab-presentations";
import { useBrowserPages } from "@/browser/use-browser-pages";
import type { InspectorContent } from "@/components/inspector/inspector-tabs";
import { useCodeDiff } from "./use-code-diff";

export function useDesktopShell() {
  const desktop = useDesktopLibrary();
  const schedules = useSchedules();
  const [scheduleView, setScheduleView] = useState(false);
  // Reopening the same thread creates a different form owner for save callbacks.
  const [scheduleCreation, setScheduleCreation] = useState<{ threadId: string }>();
  const currentScheduleCreation = useRef(scheduleCreation);
  const navigation = useDesktopTabs(desktop.library);
  const [selectedSubagents, setSelectedSubagents] = useState<Record<string, string | undefined>>(
    {},
  );
  const selectSubagent = (threadId: string, path?: string) =>
    setSelectedSubagents((current) => ({ ...current, [threadId]: path }));
  const [version, setVersion] = useState(0);
  const inspectorConversation = inspectedConversation(navigation.state);
  const inspectorActivity = useSubagents(inspectorConversation?.threadId, version);
  const subagents = inspectorActivity.agents;
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
  const diffRemote = isCloudId(contextWorkspace?.id ?? inspectorConversation?.threadId);
  const diffSupported =
    !diffRemote || Boolean(desktop.library?.bot?.capabilities?.includes("code-diff"));
  const diffConnectionKey = JSON.stringify([
    diffRemote ? desktop.library?.bot?.url : "local",
    diffRemote ? desktop.library?.bot?.status : "connected",
    inspectorConversation?.id,
    inspectorConversation?.threadId,
    version,
  ]);
  const [inspectorContent, setInspectorContent] = useState<InspectorContent>("subagents");
  const [inspectorExpanded, setInspectorExpanded] = useState(true);
  const diff = useCodeDiff({
    workspaceId: contextWorkspace?.id,
    threadId: inspectorConversation?.threadId ?? undefined,
    connectionKey: diffConnectionKey,
    revision: version + inspectorActivity.revision,
    supported: diffSupported && (!diffRemote || desktop.library?.bot?.status === "connected"),
    onOpen: () => {
      setInspectorContent("diff");
      setInspectorExpanded(true);
    },
  });
  const diffAvailable = diff.available;
  const activeInspectorContent: InspectorContent =
    inspectorContent === "diff" && diffAvailable
      ? "diff"
      : inspectorContent === "github" && githubAvailable
        ? "github"
        : inspectorContent === "subagents" && subagents.length
          ? "subagents"
          : subagents.length
            ? "subagents"
            : githubAvailable
              ? "github"
              : "diff";
  const inspectorAvailable = subagents.length > 0 || githubAvailable || diffAvailable;
  const inspectorOpen = inspectorAvailable && inspectorExpanded;
  useEffect(() => {
    githubClient.clear();
  }, [githubClient, desktop.library?.bot?.url, desktop.library?.bot?.status]);
  const selectInspectorContent = (next: InspectorContent) => {
    if (next === "diff" ? !diffAvailable : next === "github" ? !githubAvailable : !subagents.length)
      return;
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
  const { items, savePreview, threadPreviews } = useTabPresentations(
    navigation,
    desktop.library,
    browser.pages,
  );
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
    schedules,
    scheduleView,
    setScheduleView,
    showSchedules: () => {
      setScheduleView(true);
      setCollapsed(false);
      showScheduledTasks(navigation.tabs);
    },
    creatingSchedule: scheduleCreation?.threadId,
    finishSchedule: () => {
      currentScheduleCreation.current = undefined;
      setScheduleCreation(undefined);
    },
    addSchedule: (id: string) => {
      const creation = { threadId: id };
      currentScheduleCreation.current = creation;
      selectThread(id);
      setScheduleCreation(creation);
      setScheduleView(true);
      setCollapsed(false);
    },
    scheduleSaved: async (id: string) => {
      if (currentScheduleCreation.current !== scheduleCreation) return;
      const library = await desktop.refresh();
      if (currentScheduleCreation.current !== scheduleCreation) return;
      const thread = library.threads.find((thread) => thread.id === id);
      if (thread) navigation.tabs.openThread(id, thread.workspaceId);
      currentScheduleCreation.current = undefined;
      setScheduleCreation(undefined);
      setScheduleView(true);
      setCollapsed(false);
    },
    navigation,
    browser,
    items,
    savePreview,
    threadPreviews,
    selectedSubagents,
    selectSubagent,
    inspectorConversation,
    contextWorkspace,
    subagents,
    inspectorAvailable,
    inspectorOpen,
    toggleInspector,
    inspectorContent: activeInspectorContent,
    selectInspectorContent,
    diff: {
      ...diff,
      connectionKey: diffConnectionKey,
      revision: version + inspectorActivity.revision,
    },
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
