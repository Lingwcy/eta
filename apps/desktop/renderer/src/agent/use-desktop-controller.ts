import type { ImageAttachment } from "../../../src/images/types.ts";
import { useEffect, useState } from "react";
import { useThinkingStatus } from "./use-thinking-status";
import { useThreadAgent } from "./use-thread-agent";
import { DraftThread } from "./draft-thread";
import type { ConversationTab } from "./desktop-tabs";
import type { DesktopLibraryController } from "./use-desktop-library";
import type { DesktopTabController } from "./use-desktop-tabs";
import type { InputModel } from "@/components/input/types";
import type { ThinkingLevel } from "../../../src/agent/protocol";
import { hasThreadActivity } from "./thread-activity";

/** A mounted conversation keeps its composer when another tab becomes active. */
export function useDesktopController(
  tab: ConversationTab,
  desktop: DesktopLibraryController,
  navigation: DesktopTabController,
  active: boolean,
  version: number,
) {
  const [localVersion, setLocalVersion] = useState(0);
  const reconnect = () => setLocalVersion((value) => value + 1);
  const agent = useThreadAgent(tab.threadId ?? null, version + localVersion, active);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [draft] = useState(() => new DraftThread(tab.id, window.eta));
  const workspace = desktop.library?.workspaces.find(
    (workspace) => workspace.id === tab.workspaceId,
  );
  const project = desktop.library?.projects.find((project) => project.id === workspace?.projectId);
  const snapshot = agent.observation?.snapshot;
  const mainModel =
    agent.session?.model ??
    desktop.library?.models.find(
      (model) =>
        model.provider === desktop.library?.settings.defaultProvider &&
        model.id === desktop.library?.settings.defaultModel,
    ) ??
    desktop.library?.models[0];
  useEffect(() => {
    if (active)
      desktop.selectMainModel(mainModel && { provider: mainModel.provider, modelId: mainModel.id });
  }, [active, mainModel?.provider, mainModel?.id, desktop.selectMainModel]);
  const operation = snapshot?.operation;
  const thinking = useThinkingStatus(tab.threadId ?? null, snapshot);
  const running = Boolean(
    ((operation || snapshot?.compacting) && !snapshot?.recoveryRequired) ||
    agent.admission ||
    agent.submitting ||
    pending,
  );
  const backgroundWork = Boolean(snapshot && !running && hasThreadActivity(snapshot));
  const threadId = tab.threadId;
  const hasMessages =
    snapshot?.transcript.some(
      (entry) => entry.message.role === "user" || entry.message.role === "assistant",
    ) ?? false;
  useEffect(() => {
    if (threadId && snapshot && hasThreadActivity(snapshot)) navigation.activity.watch(threadId);
  }, [threadId, snapshot, navigation.activity]);
  const registerProject = async (rootPath: string, name: string) => {
    await desktop.act(async () => {
      const project = await window.eta.registerProject(rootPath, name);
      const next = await desktop.refresh();
      const workspace = next.workspaces.find(
        (value) => value.projectId === project.id && value.kind === "project-root",
      );
      navigation.tabs.updateConversation(tab.id, { workspaceId: workspace?.id ?? null });
    });
  };
  return {
    transcript: { snapshot, running },
    welcome:
      !hasMessages && !running
        ? {
            projectName: project?.name,
            connecting: !!threadId && agent.connection === "connecting",
          }
        : null,
    failure:
      error ??
      desktop.error ??
      agent.error ??
      snapshot?.blockedReason ??
      (!operation ? snapshot?.lastResult?.error?.message : undefined) ??
      (snapshot?.faulted ? "Agent 已发生错误，请新建会话。" : undefined),
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
            busy: desktop.busy || pending || !!threadId,
            library: desktop.library,
            workspaceId: tab.workspaceId,
            onProject: (id: string | null) =>
              navigation.tabs.updateConversation(tab.id, { workspaceId: id }),
            onCreateProject: registerProject,
          }
        : null,
    composer: {
      value: tab.draft,
      onChange: (draft: string) => navigation.tabs.updateConversation(tab.id, { draft }),
      model: mainModel,
      models: desktop.library?.models ?? [],
      providers: desktop.library?.providers ?? [],
      onModelChange: (model: InputModel, level: ThinkingLevel) => {
        if (running || backgroundWork) return;
        void desktop.act(async () => {
          if (threadId) await agent.configure(model.provider, model.id, level);
          else
            await window.eta.updateSettings({
              defaultProvider: model.provider,
              defaultModel: model.id,
              defaultThinkingLevel: level,
            });
        });
      },
      thinkingLevel:
        snapshot?.configuration.thinkingLevel ?? desktop.library?.settings.defaultThinkingLevel,
      contextTokens: agent.observation?.contextTokens,
      contextWindow: agent.session?.model.contextWindow,
      cwd: workspace?.cwd,
      onSubmit: async (prompt: string, images?: readonly ImageAttachment[]) => {
        desktop.clearError();
        setError(undefined);
        setPending(!threadId);
        try {
          let id = threadId;
          if (id) await agent.submit(prompt, images);
          else {
            id = await draft.submit(tab.workspaceId, prompt, images);
            navigation.tabs.updateConversation(tab.id, { threadId: id });
          }
          navigation.activity.watch(id);
        } catch (error) {
          if (!threadId && draft.persistedId)
            navigation.tabs.updateConversation(tab.id, { threadId: draft.persistedId });
          setError(error instanceof Error ? error.message : "无法发送消息");
          throw error;
        } finally {
          setPending(false);
          desktop.reload();
        }
      },
      onStop: () => void agent.stop(),
      isRunning: running || backgroundWork,
      allowSubmitWhileRunning: backgroundWork,
      isStopping: agent.stopping || operation?.status === "aborting",
      submitDisabled: !threadId && !tab.workspaceId,
      disabled:
        desktop.busy ||
        !desktop.library ||
        pending ||
        Boolean(operation?.waitingForSubagents) ||
        (!!threadId &&
          (agent.connection !== "connected" ||
            snapshot?.faulted ||
            !!snapshot?.blockedReason ||
            !!snapshot?.recoveryRequired)),
      onSettings: (category?: string) => navigation.tabs.openSettings(category),
      placeholder: "随心输入",
    },
  };
}
