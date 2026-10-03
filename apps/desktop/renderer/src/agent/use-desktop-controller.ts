import { useCallback, useEffect, useState } from "react";
import { useThinkingStatus } from "./use-thinking-status";
import { useThreadActivity } from "./use-thread-activity";
import { useThreadAgent } from "./use-thread-agent";
import { useDesktopLibrary } from "./use-desktop-library";
import type { InputModel } from "@/components/input/types";
import type { ThinkingLevel } from "../../../src/agent/protocol";

/** Connects desktop commands to presentation props; UI components never manage sessions. */
export function useDesktopController() {
  const desktop = useDesktopLibrary();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [version, setVersion] = useState(0);
  const reconnect = () => setVersion((current) => current + 1);
  const agent = useThreadAgent(desktop.threadId, version);
  const workspace = desktop.library?.workspaces.find(
    (workspace) => workspace.id === desktop.workspaceId,
  );
  const project = desktop.library?.projects.find((project) => project.id === workspace?.projectId);
  const snapshot = agent.observation?.snapshot;
  const operation = snapshot?.operation;
  const thinking = useThinkingStatus(desktop.threadId, snapshot);
  const running = Boolean(
    ((operation || snapshot?.compacting) && !snapshot?.recoveryRequired) ||
    agent.admission ||
    agent.submitting,
  );
  const runningThreadIds = useThreadActivity(desktop.threadId, snapshot, running);
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
  const openSettings = () => {
    setSettingsOpen(true);
  };
  const newThread = useCallback(() => {
    if (desktop.busy || !desktop.library) return;
    desktop.newThread();
    setSettingsOpen(false);
  }, [desktop.busy, desktop.library, desktop.newThread]);
  const chooseProject = () => void desktop.chooseProject();
  const threadId = desktop.threadId;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        newThread();
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
  }, [newThread]);

  return {
    collapsed,
    toolbar: {
      collapsed,
      canCreate: !desktop.busy && !!desktop.library,
      onToggle: () => setCollapsed((current) => !current),
      onNew: newThread,
    },
    sidebar: {
      library: desktop.library,
      runningThreadIds,
      workspaceId: desktop.workspaceId,
      threadId,
      busy: desktop.busy,
      collapsed,
      onExpand: () => setCollapsed(false),
      onSelect: desktop.select,
      onNew: newThread,
      onChoose: chooseProject,
      onSettings: openSettings,
    },
    transcript: { snapshot, running },
    transcriptKey: threadId ?? "empty",
    welcome:
      !hasMessages && !running
        ? {
            projectName: project?.name,
            connecting: !!threadId && agent.connection === "connecting",
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
    thinking,
    composerContext:
      !hasMessages && (!threadId || snapshot)
        ? {
            projectName: project?.name,
            cwd: workspace?.cwd,
            worktree: workspace?.kind === "worktree",
            busy: desktop.busy || !!threadId,
            library: desktop.library,
            workspaceId: desktop.workspaceId,
            onProject: desktop.selectWorkspace,
            onCreateProject: desktop.registerProject,
          }
        : null,
    composerKey: desktop.viewKey,
    composer: {
      model:
        agent.session?.model ??
        desktop.library?.models.find(
          (model) =>
            model.provider === desktop.library?.settings.defaultProvider &&
            model.id === desktop.library?.settings.defaultModel,
        ) ??
        desktop.library?.models[0],
      models: desktop.library?.models ?? [],
      onModelChange: (model: InputModel, level: ThinkingLevel) => {
        if (running) return;
        void desktop.act(async () => {
          if (threadId) {
            await window.eta.configureThread(threadId, model.provider, model.id, level);
            reconnect();
          } else {
            await window.eta.updateSettings({
              defaultProvider: model.provider,
              defaultModel: model.id,
              defaultThinkingLevel: level,
            });
          }
        });
      },
      thinkingLevel:
        snapshot?.configuration.thinkingLevel ?? desktop.library?.settings.defaultThinkingLevel,
      contextTokens: agent.observation?.contextTokens,
      contextWindow: agent.session?.model.contextWindow,
      onSubmit: async (prompt: string) => {
        if (!threadId) await desktop.submitDraft(prompt);
        else {
          desktop.clearError();
          await agent.submit(prompt);
          void desktop.refresh().catch(() => {});
        }
      },
      onStop: () => void agent.stop(),
      isRunning: running,
      isStopping: agent.stopping || operation?.status === "aborting",
      submitDisabled: !threadId && !desktop.workspaceId,
      disabled:
        desktop.busy ||
        !desktop.library ||
        (!!threadId &&
          (agent.connection !== "connected" ||
            snapshot?.faulted ||
            !!snapshot?.blockedReason ||
            !!snapshot?.recoveryRequired)),
      onSettings: openSettings,
      placeholder: "随心输入",
    },
    settings:
      settingsOpen && desktop.library
        ? {
            library: desktop.library,
            onChooseProject: chooseProject,
            busy: desktop.busy,
            act: desktop.act,
            error: desktop.error,
            reconnect,
            refresh: async () => {
              await desktop.refresh();
              reconnect();
            },
            onClose: () => setSettingsOpen(false),
          }
        : null,
  };
}
