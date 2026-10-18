import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { isCloudId } from "../../../../src/shared/bot.ts";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { ImageAttachment } from "@eta/core/images/types";
import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { SnapshotResponse } from "@eta/core/agent/protocol";
import type { SubagentSummary } from "@eta/core/shared/subagents";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { CompositeInput } from "@/components/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { ToastNotice } from "@/components/ui/toast";
import { subagentStatus } from "./subagent-status";
import { ApprovalNotice } from "@/components/chat/approval-notice";

export function SubagentConversation({
  threadId,
  child,
  draft,
  onDraft,
  active,
  blocked,
  onBack,
  library,
}: {
  threadId: string;
  child: SubagentSummary;
  draft: string;
  onDraft: (draft: string) => void;
  active: boolean;
  blocked: boolean;
  onBack: () => void;
  library: DesktopLibrary | null;
}) {
  useTranslation();
  const [observation, setObservation] = useState<SnapshotResponse>();
  const [error, setError] = useState<Message>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!active) return;
    setError(undefined);
    let disposed = false;
    const unsubscribe = window.eta.subscribe(
      threadId,
      (event) => {
        if (disposed) return;
        if (event.type === "snapshot") {
          setObservation(event.value);
          setError(undefined);
        } else setError(event.message);
      },
      child.path,
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadId, child.path, active]);
  const snapshot = observation?.snapshot;
  const running =
    Boolean(snapshot?.operation || child.status === "running") && !snapshot?.recoveryRequired;
  const cloud = isCloudId(threadId);
  const source = cloud ? library?.bot?.library : library;
  const enabled = source?.settings.subagents?.enabled !== false;
  const reference = snapshot?.configuration.model ?? child.model;
  const catalogModel = source?.models.find(
    (model) => model.provider === reference?.provider && model.id === reference.modelId,
  );
  const thinkingLevel = snapshot?.configuration.thinkingLevel ?? "off";
  const model =
    catalogModel ??
    (reference && {
      provider: reference.provider,
      id: reference.modelId,
      name: reference.modelId,
      thinkingLevels: [thinkingLevel],
    });
  const act = async (
    action: "send" | "stop",
    message?: string,
    images?: readonly ImageAttachment[],
  ) => {
    setBusy(true);
    setError(undefined);
    try {
      await window.eta.subagent(threadId, {
        action,
        path: child.path,
        ...(message ? { message } : {}),
        ...(images?.length ? { images } : {}),
      });
    } catch (error) {
      setError(
        describeError(error, localizedMessage("inspector:subagentConversation.operationFailed")),
      );
      throw error;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ToastNotice
        message={error ?? child.error}
        active={active}
        title={localizedMessage(
          "inspector:subagentConversation.theSubagentActionCouldNotBeCompleted",
        )}
      />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-neutral-100 px-3 py-2">
        <Button variant="ghost" size="compact" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("inspector:subagentConversation.mainChat")}
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-600" title={child.path}>
          {child.path}
        </span>
        <span role="status" className="shrink-0 text-xs text-neutral-500">
          {subagentStatus()[child.status]}
        </span>
      </div>
      <ChatTranscript
        key={`${threadId}:${child.path}`}
        snapshot={snapshot}
        running={running}
        active={active}
      >
        {snapshot?.recoveryRequired && (
          <Alert tone="warning">
            {t("inspector:subagentConversation.resumeOrStopTheUnfinishedTaskIn")}
          </Alert>
        )}
        {child.status === "stopped" && (
          <output className="text-xs text-neutral-500">
            {t("inspector:subagentConversation.theTaskHasStoppedUnfinishedWorkWas")}
          </output>
        )}
      </ChatTranscript>
      <div className="w-full shrink-0 px-5 pb-4 min-[901px]:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <ApprovalNotice
            requests={
              snapshot?.approvals?.filter(
                (request) => request.conversationId === String(child.conversationId),
              ) ?? []
            }
            busy={busy || blocked}
            history={
              snapshot?.approvalHistory?.filter(
                (request) => request.conversationId === String(child.conversationId),
              ) ?? []
            }
            onDecision={(id, approved, reuse) => {
              setBusy(true);
              void window.eta
                .decideApproval(threadId, id, approved, reuse)
                .catch((error: unknown) =>
                  setError(
                    describeError(
                      error,
                      localizedMessage("inspector:subagentConversation.approvalFailed"),
                    ),
                  ),
                )
                .finally(() => setBusy(false));
            }}
          />
          <CompositeInput
            value={draft}
            sandboxMode={snapshot?.sandbox?.mode}
            sandboxDisabled
            onChange={onDraft}
            model={model}
            models={source?.models}
            providers={library?.providers}
            thinkingLevel={thinkingLevel}
            contextTokens={observation?.contextTokens}
            contextWindow={catalogModel?.contextWindow}
            cwd={
              cloud
                ? undefined
                : library?.threads.find((thread) => thread.id === threadId)?.sessionRef.metadata.cwd
            }
            isRunning={running}
            allowSubmitWhileRunning
            isStopping={busy || snapshot?.operation?.status === "aborting"}
            onStop={() => void act("stop").catch(() => {})}
            disabled={busy || blocked || !observation || !enabled}
            placeholder={
              !enabled
                ? t("inspector:subagentConversation.subagentsAreOffEnableThemAgainIn")
                : running
                  ? t("inspector:subagentConversation.adjustTheTaskOrRequestTheResults")
                  : t("inspector:subagentConversation.adjustTheDirection")
            }
            onSubmit={async (text, images) => {
              await act("send", text, images);
            }}
          />
        </div>
      </div>
    </>
  );
}
