import { useEffect, useState } from "react";
import { getThinkingLabel } from "./selectors";
import { useThreadAgent } from "./use-thread-agent";
import { useDesktopLibrary } from "./use-desktop-library";

/** Connects desktop commands to presentation props; UI components never manage sessions. */
export function useDesktopController() {
  const desktop = useDesktopLibrary();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [version, setVersion] = useState(0);
  const [editingTitle, setEditingTitle] = useState<{ id: string; title: string } | null>(null);
  const reconnect = () => setVersion((current) => current + 1);
  const agent = useThreadAgent(desktop.threadId, version);
  const thread = desktop.library?.threads.find((thread) => thread.id === desktop.threadId);
  const workspace = desktop.library?.workspaces.find(
    (workspace) => workspace.id === desktop.workspaceId,
  );
  const project = desktop.library?.projects.find((project) => project.id === workspace?.projectId);
  const snapshot = agent.observation?.snapshot;
  const operation = snapshot?.operation;
  const running = Boolean(
    ((operation || snapshot?.compacting) && !snapshot?.recoveryRequired) ||
    agent.admission ||
    agent.submitting,
  );
  const hasMessages =
    snapshot?.transcript.some(
      (entry) => entry.message.role === "user" || entry.message.role === "assistant",
    ) ?? false;
  const failure =
    desktop.error ??
    agent.error ??
    snapshot?.blockedReason ??
    (!operation ? snapshot?.lastResult?.error?.message : undefined) ??
    (snapshot?.faulted ? "Agent 已发生错误，请新建会话。" : undefined);
  const openSettings = () => setSettingsOpen(true);
  const newThread = () => void desktop.newThread();
  const chooseProject = () => void desktop.chooseProject();
  const threadId = desktop.threadId;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void desktop.newThread();
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        setCollapsed((current) => !current);
      }
      if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktop.newThread]);

  return {
    collapsed,
    toolbar: {
      collapsed,
      canCreate: !desktop.busy && !!desktop.workspaceId,
      onToggle: () => setCollapsed((current) => !current),
      onNew: newThread,
    },
    sidebar: {
      library: desktop.library,
      workspaceId: desktop.workspaceId,
      threadId,
      busy: desktop.busy,
      collapsed,
      onExpand: () => setCollapsed(false),
      onWorkspace: desktop.selectWorkspace,
      onSelect: desktop.select,
      onNew: newThread,
      onChoose: chooseProject,
      onSettings: openSettings,
    },
    threadHeader: thread
      ? {
          title: thread.title,
          archived: thread.archivedAt !== undefined,
          busy: desktop.busy,
          canArchive: !desktop.busy && !running && !snapshot?.recoveryRequired,
          canCompact:
            !desktop.busy && !running && !snapshot?.recoveryRequired && !snapshot?.blockedReason,
          editingTitle: editingTitle?.id === thread.id ? editingTitle.title : null,
          onEditingTitle: (title: string | null) =>
            setEditingTitle(title === null ? null : { id: thread.id, title }),
          onRename: () =>
            void desktop.act(async () => {
              if (editingTitle?.id === thread.id) {
                await window.eta.renameThread(thread.id, editingTitle.title);
                setEditingTitle(null);
              }
            }),
          onArchive: () =>
            void desktop.act(async () => {
              await window.eta.archiveThread(thread.id, thread.archivedAt === undefined);
              reconnect();
            }),
          onCompact: () =>
            void desktop.act(async () => {
              await window.eta.compact(thread.id);
            }),
        }
      : null,
    transcript: { snapshot, running },
    transcriptKey: threadId ?? "empty",
    welcome:
      !hasMessages && !running
        ? {
            projectName: project?.name,
            connecting: !!threadId && agent.connection === "connecting",
            canStart: !threadId,
            busy: desktop.busy,
            hasWorkspace: !!desktop.workspaceId,
            onStart: () =>
              void (desktop.workspaceId ? desktop.newThread() : desktop.chooseProject()),
          }
        : null,
    failure,
    recovery:
      snapshot?.recoveryRequired && threadId
        ? {
            busy: desktop.busy,
            blocked: !!snapshot.blockedReason,
            onResume: () =>
              void desktop.act(async () => {
                await window.eta.resume(threadId);
                reconnect();
              }),
            onStop: () =>
              void desktop.act(async () => {
                await window.eta.stop(threadId);
                reconnect();
              }),
          }
        : null,
    stopped: snapshot?.lastResult?.status === "aborted" && !running,
    thinking:
      operation && !snapshot?.recoveryRequired
        ? { label: getThinkingLabel(snapshot!), startedAt: operation.startedAt }
        : null,
    composerContext: {
      projectName: project?.name,
      cwd: workspace?.cwd,
      worktree: workspace?.kind === "worktree",
      busy: desktop.busy,
      onProject: () => setCollapsed(false),
    },
    composerKey: agent.session?.id ?? "initial",
    composer: {
      model:
        agent.session?.model ??
        desktop.library?.models.find(
          (model) =>
            model.provider === desktop.library?.settings.defaultProvider &&
            model.id === desktop.library?.settings.defaultModel,
        ),
      thinkingLevel:
        snapshot?.configuration.thinkingLevel ?? desktop.library?.settings.defaultThinkingLevel,
      contextTokens: agent.observation?.contextTokens,
      contextWindow: agent.session?.model.contextWindow,
      onSubmit: async (prompt: string) => {
        await agent.submit(prompt);
        void desktop.refresh().catch(() => {});
      },
      onStop: () => void agent.stop(),
      isRunning: running,
      isStopping: agent.stopping || operation?.status === "aborting",
      disabled:
        !threadId ||
        agent.connection !== "connected" ||
        snapshot?.faulted ||
        !!snapshot?.blockedReason ||
        !!snapshot?.recoveryRequired,
      onSettings: openSettings,
      placeholder: "随心输入",
    },
    settings:
      settingsOpen && desktop.library
        ? {
            library: desktop.library,
            threadId,
            busy: desktop.busy,
            act: desktop.act,
            error: desktop.error,
            reconnect,
            onClose: () => setSettingsOpen(false),
          }
        : null,
  };
}
