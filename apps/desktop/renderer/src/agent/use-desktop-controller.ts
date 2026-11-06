import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { t } from "@/i18n";
import { isCloudId } from "../../../src/shared/bot.ts";
import { defaultModel, projectRootWorkspace } from "@/desktop/selectors";
import type { ImageAttachment } from "@eta/core/images/types";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { modelRecents } from "./model-recents";
import { useThinkingStatus } from "./use-thinking-status";
import { useThreadAgent } from "./use-thread-agent";
import { DraftThread } from "./draft-thread";
import type { ConversationTab } from "./desktop-tabs";
import type { DesktopLibraryController } from "./use-desktop-library";
import type { DesktopTabController } from "./use-desktop-tabs";
import type { InputModel } from "@/components/input/types";
import { resolveThinkingLevel } from "@/components/input/model-thinking";
import type { ThinkingLevel } from "@eta/core/agent/protocol";
import { hasThreadActivity } from "./thread-activity";
import { defaultSandboxMode, sandboxModes } from "@eta/core/shared/sandbox";
import type { SandboxMode } from "@eta/core/shared/sandbox";
import type { WorktreeDraft } from "@/components/input/worktree-picker";

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
  const [error, setError] = useState<Message>();
  const [draft] = useState(
    () =>
      // The created thread is bound to the tab before its first admission settles, so stop works.
      new DraftThread(tab.id, window.eta, (id, workspaceId, projectless) =>
        navigation.tabs.updateConversation(tab.id, {
          threadId: id,
          workspaceId: workspaceId ?? tab.workspaceId,
          projectless,
        }),
      ),
  );
  const [worktreeDraft, setWorktreeDraft] = useState<WorktreeDraft>({ enabled: false });
  const workspace = desktop.library?.workspaces.find(
    (workspace) => workspace.id === tab.workspaceId,
  );
  const project = desktop.library?.projects.find((project) => project.id === workspace?.projectId);
  const cloud =
    tab.threadId || tab.workspaceId
      ? isCloudId(tab.threadId ?? tab.workspaceId)
      : tab.environment === "cloud";
  const remote = desktop.library?.bot;
  // An established observation reconnects its own stream and keeps its last transcript.
  const liveObservation = Boolean(tab.threadId) && agent.connection === "connected";
  const directoryUnavailable = cloud && remote?.status !== "connected";
  const previousConnection = useRef(remote?.status);
  useEffect(() => {
    if (
      cloud &&
      remote?.status === "connected" &&
      previousConnection.current === "error" &&
      !agent.observation
    )
      setLocalVersion((value) => value + 1);
    previousConnection.current = remote?.status;
  }, [cloud, agent.observation, remote?.status]);
  const modelLibrary = cloud ? remote?.library : desktop.library;
  const recents = modelRecents();
  const recentEntries = useSyncExternalStore(recents.subscribe, recents.getSnapshot);
  const recentScope = cloud ? "cloud:" + (remote?.url ?? "") : "local";
  const recentModels = recentEntries.filter((entry) => entry.scope === recentScope);
  const recentSelection = recentModels.find((entry) =>
    modelLibrary?.models.some(
      (model) => model.provider === entry.provider && model.id === entry.modelId,
    ),
  );
  const recentModel = modelLibrary?.models.find(
    (model) => model.provider === recentSelection?.provider && model.id === recentSelection.modelId,
  );
  const [cloudSelection, setCloudSelection] = useState<{
    model: InputModel;
    thinkingLevel: ThinkingLevel;
  }>();
  const snapshot = agent.observation?.snapshot;
  const configuredProvider = snapshot?.configuration.model.provider;
  const configuredModelId = snapshot?.configuration.model.modelId;
  const sessionModel = agent.session?.model;
  const catalogModels = modelLibrary?.models;
  const liveModel = useMemo(() => {
    if (
      sessionModel &&
      sessionModel.provider === configuredProvider &&
      sessionModel.id === configuredModelId
    )
      return sessionModel;
    return catalogModels?.find(
      (model) => model.provider === configuredProvider && model.id === configuredModelId,
    );
  }, [sessionModel, configuredProvider, configuredModelId, catalogModels]);
  const mainModel = snapshot
    ? liveModel
    : (agent.session?.model ??
      (cloud && cloudSelection
        ? cloudSelection.model
        : modelLibrary
          ? (recentModel ?? defaultModel(modelLibrary))
          : undefined));
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
  // Until a durable thread exists there is nothing to stop; the composer stays disabled instead.
  const creating = pending && !tab.threadId;
  const sandboxDisabledReason =
    cloud && remote?.status !== "connected"
      ? t("chat:useDesktopController.botIsDisconnectedReconnectInSettingsBefore")
      : cloud && !remote?.library?.allowedSandboxModes?.length
        ? t("chat:useDesktopController.thisBotDoesNotSupportSandboxingUpdate")
        : running || backgroundWork
          ? t("chat:useDesktopController.stopTheThreadAndItsSubagentsBefore")
          : snapshot?.recoveryRequired
            ? t("chat:useDesktopController.resumeOrStopTheCurrentTaskBefore")
            : tab.threadId && agent.connection !== "connected"
              ? t("chat:useDesktopController.theChatConnectionIsNotReadyReopen")
              : desktop.busy || pending
                ? t("chat:useDesktopController.savingChangesWaitBeforeChangingThePolicy")
                : undefined;
  const threadId = tab.threadId;
  const hasMessages = Boolean(
    agent.submittedInputs.length ||
    snapshot?.queuedInputs?.length ||
    snapshot?.transcript.some(
      (entry) => entry.message.role === "user" || entry.message.role === "assistant",
    ),
  );
  useEffect(() => {
    if (threadId && snapshot && hasThreadActivity(snapshot)) navigation.activity.watch(threadId);
  }, [threadId, snapshot, navigation.activity]);
  const registerProject = async (rootPath: string, name: string, requestId: string) => {
    await desktop.act(async () => {
      const project = cloud
        ? await window.eta.createCloudProject(name, requestId)
        : await window.eta.registerProject(rootPath, name);
      const next = await desktop.refresh();
      const workspace = projectRootWorkspace(next.workspaces, project.id);
      setWorktreeDraft({ enabled: false });
      navigation.tabs.updateConversation(tab.id, { workspaceId: workspace?.id ?? null });
    });
  };
  return {
    transcript: {
      submittedInputs: agent.submittedInputs,
      snapshot,
      running,
    },
    loading:
      threadId && !snapshot
        ? { loading: agent.connection === "connecting", onRetry: reconnect }
        : null,
    welcome:
      !hasMessages && !running && (!threadId || !!snapshot)
        ? {
            projectName: project?.name,
            connecting: !!threadId && agent.connection === "connecting",
          }
        : null,
    failure:
      (cloud && remote?.status !== "connected"
        ? (remote?.message ?? t("chat:useDesktopController.botIsDisconnectedReconnectInSettings"))
        : undefined) ??
      error ??
      (!threadId &&
      !tab.workspaceId &&
      cloud &&
      remote?.status === "connected" &&
      !remote.capabilities?.includes("temporary-workspace")
        ? t("chat:useDesktopController.temporaryWorkspaceUnsupported")
        : undefined) ??
      agent.error ??
      snapshot?.blockedReason ??
      (!operation ? snapshot?.lastResult?.error?.message : undefined) ??
      (snapshot?.faulted
        ? t("chat:useDesktopController.theAgentEncounteredAnErrorStartA")
        : undefined),
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
    approval: {
      requests: snapshot?.approvals ?? [],
      // Automatic decisions stay visible while the run that produced them is still going.
      history: running ? (snapshot?.approvalHistory ?? []) : [],
      busy: desktop.busy || Boolean(snapshot?.recoveryRequired),
      onDecision: (id: string, approved: boolean, reuse?: "call" | "run") => {
        if (threadId)
          void desktop.act(async () => {
            await window.eta.decideApproval(threadId, id, approved, reuse);
          });
      },
    },
    composerContext:
      threadId || pending || !active
        ? null
        : {
            cloud,
            onEnvironment: (next: boolean) => {
              desktop.clearError();
              setError(undefined);
              setCloudSelection(undefined);
              setWorktreeDraft({ enabled: false });
              navigation.tabs.updateConversation(tab.id, {
                environment: next ? "cloud" : "local",
                workspaceId: null,
                sandboxMode: undefined,
              });
            },
            onSettings: () => navigation.tabs.openSettings("bot"),
            projectName: project?.name,
            cwd: workspace?.cwd,
            worktree: workspace?.kind === "worktree",
            busy: desktop.busy,
            library: desktop.library,
            workspaceId: tab.workspaceId,
            onProject: (id: string | null) => {
              setWorktreeDraft({ enabled: false });
              navigation.tabs.updateConversation(tab.id, {
                workspaceId: id,
                environment: id ? (isCloudId(id) ? "cloud" : "local") : cloud ? "cloud" : "local",
              });
            },
            onCreateProject: registerProject,
            worktreeDraft,
            onWorktreeDraft: (next: WorktreeDraft) => {
              setWorktreeDraft(next);
            },
            ...(cloud && !remote?.capabilities?.includes("worktree")
              ? {
                  worktreeUnsupported: t(
                    "chat:useDesktopController.thisBotVersionDoesNotSupportWorktrees",
                  ),
                }
              : {}),
          },
    composer: {
      value: tab.draft,
      onChange: (draft: string) => navigation.tabs.updateConversation(tab.id, { draft }),
      model: mainModel,
      cloud,
      sandboxMode:
        snapshot?.sandbox?.mode ??
        tab.sandboxMode ??
        modelLibrary?.settings.defaultSandboxMode ??
        defaultSandboxMode,
      allowedSandboxModes:
        snapshot?.sandbox?.allowedModes ??
        (cloud ? (remote?.library?.allowedSandboxModes ?? []) : sandboxModes),
      sandboxDisabled: Boolean(sandboxDisabledReason),
      sandboxDisabledReason,
      onSandboxChange: (mode: SandboxMode) => {
        if (threadId)
          void desktop.act(async () => {
            await agent.configureSandbox(mode);
          });
        else navigation.tabs.updateConversation(tab.id, { sandboxMode: mode });
      },
      models: modelLibrary?.models ?? [],
      recentModels,
      providers: cloud
        ? [...new Set(modelLibrary?.models.map((model) => model.provider) ?? [])].map((id) => ({
            id,
            name: id,
          }))
        : (desktop.library?.providers ?? []),
      onModelChange: (model: InputModel, level: ThinkingLevel) => {
        if (running || backgroundWork) return;
        void desktop.act(async () => {
          if (threadId) await agent.configure(model.provider, model.id, level);
          else if (cloud) setCloudSelection({ model, thinkingLevel: level });
          else
            await window.eta.updateSettings({
              defaultProvider: model.provider,
              defaultModel: model.id,
              defaultThinkingLevel: level,
            });
          recents.record({
            scope: recentScope,
            provider: model.provider,
            modelId: model.id,
            thinkingLevel: level,
          });
        });
      },
      thinkingLevel:
        snapshot?.configuration.thinkingLevel ??
        (cloud
          ? (cloudSelection?.thinkingLevel ??
            recentSelection?.thinkingLevel ??
            modelLibrary?.settings.defaultThinkingLevel)
          : (recentSelection?.thinkingLevel ?? desktop.library?.settings.defaultThinkingLevel)),
      contextTokens: agent.observation?.contextTokens,
      contextWindow: snapshot ? liveModel?.contextWindow : agent.session?.model.contextWindow,
      cwd: cloud ? undefined : workspace?.cwd,
      onSubmit: async (
        prompt: string,
        images?: readonly ImageAttachment[],
        whenBusy?: import("@eta/core/agent/protocol").InputMode,
      ) => {
        desktop.clearError();
        setError(undefined);
        setPending(!threadId);
        try {
          let id = threadId;
          if (id) await agent.submit(prompt, images, whenBusy);
          else {
            id = await draft.submit(
              tab.workspaceId,
              prompt,
              images,
              mainModel
                ? {
                    provider: mainModel.provider,
                    modelId: mainModel.id,
                    thinkingLevel: resolveThinkingLevel(
                      mainModel,
                      cloudSelection?.thinkingLevel ??
                        recentSelection?.thinkingLevel ??
                        modelLibrary?.settings.defaultThinkingLevel ??
                        "off",
                    ),
                    sandboxMode:
                      tab.sandboxMode ??
                      modelLibrary?.settings.defaultSandboxMode ??
                      defaultSandboxMode,
                  }
                : undefined,
              worktreeDraft.enabled && worktreeDraft.branch && workspace?.projectId
                ? {
                    projectId: workspace.projectId,
                    baseWorkspaceId: workspace.id,
                    branch: worktreeDraft.branch,
                  }
                : undefined,
              cloud ? "cloud" : "local",
            );
            navigation.tabs.updateConversation(tab.id, {
              threadId: id,
              workspaceId: draft.persistedWorkspaceId ?? tab.workspaceId,
            });
          }
          if (mainModel)
            recents.record({
              scope: recentScope,
              provider: mainModel.provider,
              modelId: mainModel.id,
              thinkingLevel:
                snapshot?.configuration.thinkingLevel ??
                cloudSelection?.thinkingLevel ??
                recentSelection?.thinkingLevel ??
                modelLibrary?.settings.defaultThinkingLevel ??
                "off",
            });
          navigation.recordInput(id);
          navigation.activity.watch(id);
        } catch (error) {
          if (!threadId && draft.persistedId)
            navigation.tabs.updateConversation(tab.id, {
              threadId: draft.persistedId,
              workspaceId: draft.persistedWorkspaceId ?? tab.workspaceId,
            });
          setError(
            describeError(
              error,
              localizedMessage("chat:useDesktopController.cannotSendTheMessage"),
            ),
          );
          throw error;
        } finally {
          setPending(false);
          desktop.reload();
        }
      },
      onStop: () => void agent.stop(),
      isRunning: (running || backgroundWork) && !creating,
      allowSubmitWhileRunning: backgroundWork || snapshot?.inputQueueSupported === true,
      inputQueueSupported: snapshot?.inputQueueSupported === true,
      isStopping: agent.stopping || operation?.status === "aborting",
      submitDisabled:
        (directoryUnavailable && !liveObservation) ||
        (!threadId &&
          !tab.workspaceId &&
          cloud &&
          !remote?.capabilities?.includes("temporary-workspace")),
      disabled:
        desktop.busy ||
        (directoryUnavailable && !liveObservation) ||
        !desktop.library ||
        pending ||
        (!!threadId &&
          (agent.connection !== "connected" ||
            snapshot?.faulted ||
            !!snapshot?.blockedReason ||
            !!snapshot?.recoveryRequired)),
      onSettings: (category?: string) => navigation.tabs.openSettings(category),
      placeholder: t("chat:useDesktopController.askAnything"),
    },
  };
}
