import type { Schedule } from "@eta/core/shared/schedules";
import { useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SchedulesController } from "@/agent/use-schedules";
import { Button } from "@/components/ui/button";
import { Popover } from "@base-ui/react/popover";
import { Plus, ListFilter, Check, Monitor, Cloud } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScheduleMenu } from "./schedule-menu";
import { ScheduleForm } from "./schedule-form";
import { scheduleRuleText, scheduleTime } from "./format";
import { ToastNotice } from "@/components/ui/toast";
import "./schedule-status.css";

export function ScheduleSidebar({
  library,
  controller,
  selectedThreadId,
  onSelect,
  onSaved,
}: {
  selectedThreadId?: string | null;
  library: DesktopLibrary | null;
  controller: SchedulesController;
  onSelect(this: void, id: string): void;
  onSaved(this: void, id: string): void;
}) {
  const [states, setStates] = useState(["active", "paused", "completed"]);
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<Schedule>();
  const [acting, setActing] = useState(false);
  const [submittingRun, setSubmittingRun] = useState<string>();
  const [error, setError] = useState<string>();
  const action = async (plan: Schedule, kind: "pause" | "resume" | "run" | "edit" | "delete") => {
    if (kind === "edit") {
      setEdit(plan);
      return;
    }
    setActing(true);
    if (kind === "run") setSubmittingRun(plan.threadId);
    setError(undefined);
    try {
      await controller.mutate(
        JSON.stringify([plan.id, plan.revision, kind]),
        (requestId) =>
          kind === "run"
            ? window.eta.runSchedule({
                threadId: plan.threadId,
                requestId,
                scheduleId: plan.id,
                expectedRevision: plan.revision,
              })
            : window.eta.writeSchedule({
                threadId: plan.threadId,
                requestId,
                change: { action: kind, scheduleId: plan.id, expectedRevision: plan.revision },
              }),
        plan.threadId,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法处理定时任务");
    } finally {
      setActing(false);
      setSubmittingRun(undefined);
    }
  };
  const groups = controller.snapshot.snapshots
    .flatMap(({ environment, data }) => {
      const ids = new Set(
        data.schedules.filter((plan) => plan.deletedAt === undefined).map((plan) => plan.threadId),
      );
      return [...ids]
        .map((id) => {
          const thread = library?.threads.find((item) => item.id === id);
          const plans = data.schedules.filter(
            (plan) => plan.threadId === id && plan.deletedAt === undefined,
          );
          const next = plans
            .filter((plan) => plan.state === "active" && plan.nextRunAt !== null)
            .toSorted((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
          const runs = data.occurrences?.filter((run) => run.threadId === id) ?? [];
          const latest = runs.toSorted((a, b) => b.scheduledAt - a.scheduledAt)[0];
          const status =
            submittingRun === id
              ? "正在提交"
              : runs.some((run) => run.state === "admitted")
                ? "执行中"
                : runs.some((run) => ["pending", "dispatching"].includes(run.state))
                  ? "等待执行"
                  : latest?.state === "succeeded"
                    ? "执行成功"
                    : latest?.state === "failed"
                      ? "会话错误"
                      : undefined;
          return {
            id,
            title: next?.name ?? plans[0]?.name ?? thread?.title ?? "新聊天",
            plans,
            next,
            status,
            environment,
            archived: thread?.archivedAt !== undefined,
            unavailable:
              data.requests.some((request) => request.threadId === id) ||
              data.lifecycleIntents.some((intent) => intent.threadId === id),
          };
        })
        .filter((group) => group.plans.some((plan) => states.includes(plan.state)));
    })
    .toSorted((a, b) => (a.next?.nextRunAt ?? Infinity) - (b.next?.nextRunAt ?? Infinity));
  return (
    <aside
      aria-label="定时任务"
      className="flex w-[var(--sidebar-width)] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#f8f8f8] py-2"
    >
      <div className="px-2 py-1">
        <Button variant="ghost" size="row-sm" disabled={!library} onClick={() => setCreating(true)}>
          <Plus size={16} /> 新建任务
        </Button>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs text-neutral-500">即将执行</span>
        <Popover.Root>
          <Popover.Trigger
            render={
              <Button variant="ghost" size="icon-xs" aria-label="筛选任务状态">
                <ListFilter size={15} />
              </Button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
              <Popover.Popup className="min-w-40 rounded-[10px] border border-black/12 bg-[#f8f8f8]/95 p-1 text-xs shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] outline-none backdrop-blur-xl">
                <p className="px-2 py-1 text-neutral-500">筛选依据</p>
                {[
                  ["active", "已开启"],
                  ["paused", "已暂停"],
                  ["completed", "已完成"],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    variant="menu"
                    size="menu-item"
                    role="menuitemcheckbox"
                    aria-checked={states.includes(value)}
                    onClick={() =>
                      setStates((current) =>
                        current.includes(value)
                          ? current.filter((item) => item !== value)
                          : [...current, value],
                      )
                    }
                  >
                    <span className="flex-1">{label}</span>
                    {states.includes(value) && <Check size={14} />}
                  </Button>
                ))}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {(creating || edit) && library && (
        <ScheduleForm
          key={edit?.id ?? "new"}
          library={library}
          controller={controller}
          schedule={edit}
          threadId={edit?.threadId}
          workspaceId={library.threads.find((thread) => thread.id === edit?.threadId)?.workspaceId}
          onCancel={() => {
            setCreating(false);
            setEdit(undefined);
          }}
          onSaved={(id) => {
            setCreating(false);
            setEdit(undefined);
            onSaved(id);
          }}
        />
      )}
      <ScrollArea className="flex-1" gutter="overlay">
        <ToastNotice
          message={error ?? controller.error}
          title="定时任务操作未完成"
          onRetry={() => void controller.refresh()}
        />
        <nav>
          {groups.map((group) => (
            <div key={group.id} className="px-2 py-1">
              <div className="relative">
                <Button
                  variant="ghost"
                  size="row-sm"
                  selected={group.id === selectedThreadId}
                  onClick={() => onSelect(group.id)}
                >
                  <span className="flex min-w-0 flex-col gap-1 pr-6">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {group.environment.id === "local" ? (
                        <Monitor
                          size={13}
                          aria-label="本地任务"
                          className="shrink-0 text-neutral-400"
                        />
                      ) : (
                        <Cloud
                          size={13}
                          aria-label="Bot 任务"
                          className="shrink-0 text-neutral-400"
                        />
                      )}
                      <span className="truncate">{group.title}</span>
                    </span>
                    <span className="truncate text-xs text-neutral-500">
                      {group.next
                        ? `${scheduleTime(group.next.nextRunAt)} · ${scheduleRuleText(group.next.rule)}`
                        : group.archived
                          ? "已归档"
                          : group.plans.some((plan) => plan.state === "paused")
                            ? "已暂停"
                            : "已完成"}
                      {group.plans.length > 1 ? ` · ${group.plans.length} 个计划` : ""}
                      {group.status ? ` · ${group.status}` : ""}
                    </span>
                  </span>
                </Button>
                {group.status && (
                  <span
                    role="status"
                    aria-label={group.status}
                    title={group.status}
                    className={`absolute top-1.5 right-2 size-1.5 rounded-full ${
                      group.status === "执行中"
                        ? "schedule-running-light bg-blue-500"
                        : group.status === "执行成功"
                          ? "bg-green-500"
                          : group.status === "会话错误"
                            ? "bg-red-500"
                            : "bg-neutral-400"
                    }`}
                  />
                )}
                {!!group.plans.length && (
                  <div className="absolute top-1/2 right-1 -translate-y-1/2">
                    <ScheduleMenu
                      plans={group.plans}
                      label={group.title}
                      disabled={
                        acting ||
                        group.unavailable ||
                        group.archived ||
                        group.environment.status !== "connected"
                      }
                      onAction={(plan, kind) => void action(plan, kind)}
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </nav>
        {!groups.length && <p className="px-3 py-2 text-xs text-neutral-400">暂无符合条件的任务</p>}
      </ScrollArea>
    </aside>
  );
}
