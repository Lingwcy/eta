import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { createContext, useContext, useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { Schema } from "effect";
import type { SnapshotTool } from "@eta/core/agent/protocol";
import {
  ScheduleToolResultSchema,
  type ScheduleToolResult,
  type ScheduleRequest,
} from "@eta/core/shared/schedules";
import type { SchedulesController } from "@/agent/use-schedules";
import { Button } from "@/components/ui/button";
import { scheduleRuleText, scheduleTime } from "./format";
import { ToastNotice } from "@/components/ui/toast";

export const ScheduleMessages = createContext<
  { threadId?: string; controller: SchedulesController } | undefined
>(undefined);

export function scheduleToolResult(tool: SnapshotTool) {
  if (tool.toolName !== "schedule" || tool.status !== "settled" || tool.isError) return undefined;
  try {
    return Schema.decodeUnknownSync(ScheduleToolResultSchema)(tool.result?.details);
  } catch {
    return undefined;
  }
}

export function ScheduleToolNotice({ result }: { result: ScheduleToolResult }) {
  useTranslation();
  const context = useContext(ScheduleMessages);
  const [scheduleId, setScheduleId] = useState<string>();
  const [receiptState, setReceiptState] = useState<ScheduleRequest["state"]>();
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<Message>();
  const [retry, setRetry] = useState(0);
  const threadId = context?.threadId;
  const scoped = context?.controller.snapshot.snapshots.find(
    ({ environment }) =>
      threadId &&
      (environment.id === "local"
        ? !threadId.startsWith("bot:")
        : threadId.startsWith(environment.id)),
  );
  const awaiting = scoped?.data.requests.some((receipt) => receipt.requestId === result.requestId);
  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    setError(undefined);
    // Receipt IDs are opaque across environments; entity IDs in the transport reply are mapped.
    void window.eta
      .scheduleRequest(threadId, result.requestId)
      .then((receipt) => {
        if (!disposed && receipt?.threadId === threadId) {
          setScheduleId(receipt.scheduleId);
          setReceiptState(receipt.state);
          if (receipt.state === "rejected")
            setError(
              receipt.reason ?? t("schedules:scheduleToolNotice.theScheduleChangeDidNotTakeEffect"),
            );
        }
      })
      .catch((error: unknown) => {
        if (!disposed)
          setError(
            describeError(
              error,
              localizedMessage("schedules:scheduleToolNotice.cannotReadTheScheduleRecord"),
            ),
          );
      });
    return () => {
      disposed = true;
    };
  }, [threadId, result.requestId, scoped?.environment.status, awaiting, retry]);
  const entity = context?.controller.snapshot.snapshots.find(({ data }) =>
    data.schedules.some((plan) => plan.id === scheduleId && plan.threadId === threadId),
  );
  const plan = entity?.data.schedules.find(
    (plan) => plan.id === scheduleId && plan.threadId === threadId,
  );
  const deleted =
    cancelled ||
    plan?.deletedAt !== undefined ||
    (result.action === "delete" && (receiptState ?? result.status) === "applied");
  const shownRule = plan?.rule ?? result.rule;
  const shownName = plan?.name ?? result.name;
  const pending = entity?.data.requests.some((request) => request.threadId === threadId);
  const cancel = async () => {
    if (!context || !threadId || !plan || plan.deletedAt !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await context.controller.mutate(
        JSON.stringify([plan.id, plan.revision, "delete"]),
        (requestId) =>
          window.eta.writeSchedule({
            threadId,
            requestId,
            change: { action: "delete", scheduleId: plan.id, expectedRevision: plan.revision },
          }),
        threadId,
      );
      if (receipt.state === "applied") setCancelled(true);
    } catch (error) {
      setError(
        describeError(
          error,
          localizedMessage("schedules:scheduleToolNotice.cannotCancelTheSchedule"),
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    create: t("schedules:scheduleToolNotice.scheduledTaskCreated"),
    update: t("schedules:scheduleToolNotice.scheduledTaskUpdated"),
    pause: t("schedules:scheduleToolNotice.scheduledTaskPaused"),
    resume: t("schedules:scheduleToolNotice.scheduledTaskResumed"),
    delete: t("schedules:scheduleToolNotice.scheduledTaskCancelled"),
  };
  return (
    <div className="flex flex-col gap-1 py-1 text-xs text-neutral-500">
      <div className="flex items-center gap-2">
        <Clock3 size={14} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {deleted
            ? t("schedules:scheduleToolNotice.scheduleCancelled")
            : receiptState === "rejected"
              ? t("schedules:scheduleToolNotice.theScheduleChangeDidNotTakeEffect")
              : (receiptState ?? result.status) === "pending"
                ? t("schedules:scheduleToolNotice.processingTheScheduleChange")
                : labels[result.action]}
          {shownName ? ` · ${shownName}` : ""}
        </span>
        {!deleted && (
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={busy || !plan || pending || entity?.environment.status !== "connected"}
            onClick={() => void cancel()}
          >
            {busy || pending
              ? t("schedules:scheduleToolNotice.processing")
              : t("schedules:scheduleToolNotice.cancelSchedule")}
          </Button>
        )}
      </div>
      {!deleted && shownRule && (
        <p className="pl-6">
          {scheduleRuleText(shownRule)}
          {plan?.nextRunAt
            ? t("schedules:scheduleToolNotice.next", { value1: scheduleTime(plan.nextRunAt) })
            : ""}
        </p>
      )}
      <ToastNotice
        message={error}
        title={localizedMessage("schedules:scheduleToolNotice.theScheduledTaskActionCouldNotBe")}
        onRetry={() => {
          setRetry((value) => value + 1);
          void context?.controller.refresh();
        }}
      />
    </div>
  );
}
