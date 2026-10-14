import { useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SchedulesController } from "@/agent/use-schedules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScheduleForm } from "./schedule-form";
import { scheduleRuleText, scheduleTime } from "./format";

export function ScheduleSidebar({
  library,
  controller,
  onSelect,
  onSaved,
}: {
  library: DesktopLibrary | null;
  controller: SchedulesController;
  onSelect(this: void, id: string): void;
  onSaved(this: void, id: string): void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("upcoming");
  const [creating, setCreating] = useState(false);
  const groups = controller.snapshot.snapshots
    .flatMap(({ environment, data }) => {
      const ids = new Set([
        ...data.schedules
          .filter((plan) => plan.deletedAt === undefined)
          .map((plan) => plan.threadId),
        ...data.proposals
          .filter((proposal) => proposal.state === "pending")
          .map((proposal) => proposal.threadId),
      ]);
      return [...ids]
        .map((id) => {
          const thread = library?.threads.find((item) => item.id === id);
          const plans = data.schedules.filter(
            (plan) => plan.threadId === id && plan.deletedAt === undefined,
          );
          const pending = data.proposals.some(
            (proposal) => proposal.threadId === id && proposal.state === "pending",
          );
          const next = plans
            .filter((plan) => plan.state === "active" && plan.nextRunAt !== null)
            .toSorted((a, b) => a.nextRunAt! - b.nextRunAt!)[0];
          const latest = data.occurrences
            ?.filter((run) => run.threadId === id)
            .toSorted((a, b) => b.scheduledAt - a.scheduledAt)[0];
          return {
            id,
            title: thread?.title || "新聊天",
            plans,
            pending,
            next,
            latest,
            environment,
            archived: thread?.archivedAt !== undefined,
          };
        })
        .filter(
          (group) =>
            group.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) &&
            (filter === "pending"
              ? group.pending
              : filter === "blocked"
                ? group.plans.some((plan) => !!plan.blockedReason)
                : filter === "upcoming"
                  ? !!group.next || group.pending
                  : group.plans.some((plan) => plan.state === filter)),
        );
    })
    .toSorted((a, b) => (a.next?.nextRunAt ?? Infinity) - (b.next?.nextRunAt ?? Infinity));
  return (
    <aside
      aria-label="定时任务"
      className="flex w-[var(--sidebar-width)] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#f8f8f8] py-2"
    >
      <div className="flex items-center justify-between px-2">
        <span className="text-xs">定时任务</span>
        <Button variant="ghost" size="sm" disabled={!library} onClick={() => setCreating(true)}>
          新建任务
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {creating && library ? (
          <ScheduleForm
            library={library}
            controller={controller}
            onCancel={() => setCreating(false)}
            onSaved={(id) => {
              setCreating(false);
              onSaved(id);
            }}
          />
        ) : (
          <>
            <div className="flex flex-col gap-2 px-2 py-2">
              <Input
                variant="compact"
                aria-label="搜索定时任务"
                placeholder="搜索"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Select
                label="任务状态"
                size="compact"
                variant="menu"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "upcoming", label: "即将执行" },
                  { value: "paused", label: "已暂停" },
                  { value: "completed", label: "已完成" },
                  { value: "blocked", label: "阻塞" },
                  { value: "pending", label: "待确认" },
                ]}
              />
            </div>
            {controller.snapshot.snapshots
              .filter(({ environment }) => environment.status !== "connected")
              .map(({ environment }) => (
                <p key={environment.id} className="px-3 py-1 text-xs text-neutral-500">
                  {environment.label} · {environment.message}
                </p>
              ))}
            {controller.error && (
              <p role="alert" className="px-3 text-xs">
                {controller.error}
                <Button variant="ghost" size="sm" onClick={() => void controller.refresh()}>
                  重试
                </Button>
              </p>
            )}
            <nav>
              {groups.map((group) => (
                <div key={group.id} className="px-2 py-1">
                  <Button variant="ghost" size="row-compact" onClick={() => onSelect(group.id)}>
                    <span className="truncate">{group.title}</span>
                  </Button>
                  <p className="px-2 text-xs text-neutral-500">
                    {group.environment.label} ·{" "}
                    {group.next
                      ? scheduleTime(group.next.nextRunAt)
                      : group.pending
                        ? "待确认"
                        : group.archived
                          ? "已归档"
                          : "无后续执行"}
                  </p>
                  <p className="px-2 text-xs text-neutral-500">
                    {group.next ? scheduleRuleText(group.next.rule) : ""}
                    {group.plans.length > 1 ? ` · ${group.plans.length} 个计划` : ""}
                    {group.latest?.state === "admitted"
                      ? " · 执行中"
                      : group.latest?.state === "failed"
                        ? " · 最近失败"
                        : ""}
                  </p>
                </div>
              ))}
            </nav>
            {!groups.length && (
              <p className="px-3 py-2 text-xs text-neutral-400">暂无符合条件的任务</p>
            )}
          </>
        )}
      </ScrollArea>
    </aside>
  );
}
