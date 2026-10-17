import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { threadTitle } from "@/i18n/thread-title";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
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
import { scheduleRunStatus } from "./run-status";
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
  useTranslation();
  const [states, setStates] = useState(["active", "paused", "completed"]);
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<Schedule>();
  const [acting, setActing] = useState(false);
  const [submittingRun, setSubmittingRun] = useState<string>();
  const [error, setError] = useState<Message>();
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
      if (kind === "run") onSelect(plan.threadId);
    } catch (error) {
      setError(
        describeError(
          error,
          localizedMessage("schedules:scheduleSidebar.cannotProcessTheScheduledTask"),
        ),
      );
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
          const status =
            submittingRun === id
              ? {
                  state: "submitting",
                  label: t("schedules:scheduleSidebar.submitting"),
                  detail: undefined,
                }
              : scheduleRunStatus(runs, plans, environment);
          return {
            id,
            title: next?.name ?? plans[0]?.name ?? threadTitle(thread),
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
      aria-label={t("schedules:scheduleSidebar.scheduledTasks")}
      className="flex w-[var(--sidebar-width)] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#f8f8f8] py-2"
    >
      <div className="px-2 py-1">
        <Button variant="ghost" size="row-sm" disabled={!library} onClick={() => setCreating(true)}>
          <Plus size={16} />
          {t("schedules:scheduleSidebar.newTask")}
        </Button>
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs text-neutral-500">{t("schedules:scheduleSidebar.upcoming")}</span>
        <Popover.Root>
          <Popover.Trigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("schedules:scheduleSidebar.filterTaskStatus")}
              >
                <ListFilter size={15} />
              </Button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
              <Popover.Popup className="min-w-40 rounded-[10px] border border-black/12 bg-[#f8f8f8]/95 p-1 text-xs shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] outline-none backdrop-blur-xl">
                <p className="px-2 py-1 text-neutral-500">
                  {t("schedules:scheduleSidebar.filterBy")}
                </p>
                {[
                  ["active", t("schedules:scheduleSidebar.on")],
                  ["paused", t("schedules:scheduleSidebar.paused")],
                  ["completed", t("schedules:scheduleSidebar.completed")],
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
          title={localizedMessage("schedules:scheduleSidebar.theScheduledTaskActionCouldNotBe")}
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
                          aria-label={t("schedules:scheduleSidebar.localTask")}
                          className="shrink-0 text-neutral-400"
                        />
                      ) : (
                        <Cloud
                          size={13}
                          aria-label={t("schedules:scheduleSidebar.botTask")}
                          className="shrink-0 text-neutral-400"
                        />
                      )}
                      <span className="truncate">{group.title}</span>
                    </span>
                    <span
                      className="truncate text-xs text-neutral-500"
                      title={group.status?.detail}
                    >
                      {group.next
                        ? `${scheduleTime(group.next.nextRunAt)} · ${scheduleRuleText(group.next.rule)}`
                        : group.archived
                          ? t("schedules:scheduleSidebar.archived")
                          : group.plans.some((plan) => plan.state === "paused")
                            ? t("schedules:scheduleSidebar.paused")
                            : t("schedules:scheduleSidebar.completed")}
                      {group.plans.length > 1
                        ? t("schedules:scheduleSidebar.schedules", { count: group.plans.length })
                        : ""}
                      {group.status
                        ? ` · ${group.status.label}${group.status.detail ? ` · ${group.status.detail}` : ""}`
                        : ""}
                    </span>
                  </span>
                </Button>
                {group.status && (
                  <span
                    role="status"
                    aria-label={group.status.label}
                    title={group.status.detail ?? group.status.label}
                    className={`absolute top-1.5 right-2 size-1.5 rounded-full ${
                      group.status.state === "running"
                        ? "schedule-running-light bg-blue-500"
                        : group.status.state === "succeeded"
                          ? "bg-green-500"
                          : group.status.state === "failed"
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
        {!groups.length && (
          <p className="px-3 py-2 text-xs text-neutral-400">
            {t("schedules:scheduleSidebar.noTasksMatchTheseFilters")}
          </p>
        )}
      </ScrollArea>
    </aside>
  );
}
