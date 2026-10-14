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
  const context = useContext(ScheduleMessages);
  const [scheduleId, setScheduleId] = useState<string>();
  const [receiptState, setReceiptState] = useState<ScheduleRequest["state"]>();
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string>();
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
          if (receipt.state === "rejected") setError(receipt.reason ?? "计划变更未生效");
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setError(error instanceof Error ? error.message : "无法读取计划记录");
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
      setError(error instanceof Error ? error.message : "无法取消计划");
    } finally {
      setBusy(false);
    }
  };
  const labels = {
    create: "已创建定时任务",
    update: "已修改定时任务",
    pause: "已暂停定时任务",
    resume: "已恢复定时任务",
    delete: "已取消定时任务",
  };
  return (
    <div className="flex flex-col gap-1 py-1 text-xs text-neutral-500">
      <div className="flex items-center gap-2">
        <Clock3 size={14} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {deleted
            ? "计划已取消"
            : receiptState === "rejected"
              ? "计划变更未生效"
              : (receiptState ?? result.status) === "pending"
                ? "正在处理计划变更"
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
            {busy || pending ? "正在处理" : "取消计划"}
          </Button>
        )}
      </div>
      {!deleted && shownRule && (
        <p className="pl-6">
          {scheduleRuleText(shownRule)}
          {plan?.nextRunAt ? ` · 下一次 ${scheduleTime(plan.nextRunAt)}` : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="pl-6 text-red-600">
          {error}
          <Button
            variant="ghost-muted"
            size="compact"
            onClick={() => {
              setRetry((value) => value + 1);
              void context?.controller.refresh();
            }}
          >
            重试
          </Button>
        </p>
      )}
    </div>
  );
}
