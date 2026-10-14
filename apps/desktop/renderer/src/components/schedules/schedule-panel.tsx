import { Clock3, Monitor, Cloud, Hourglass } from "lucide-react";
import { useEffect, useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { Schedule, ScheduleProposal } from "@eta/core/shared/schedules";
import type { SchedulesController } from "@/agent/use-schedules";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScheduleForm } from "./schedule-form";
import { scheduleRuleText, scheduleTime, scheduleStates, runStates } from "./format";

export function SchedulePanel({
  controller,
  library,
  threadId,
  creating,
  onCreate,
  onDone,
}: {
  controller: SchedulesController;
  library: DesktopLibrary;
  threadId: string;
  creating: boolean;
  onCreate(this: void): void;
  onDone(this: void): void;
}) {
  const [edit, setEdit] = useState<{ schedule?: Schedule; proposal?: ScheduleProposal }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<string>();
  const [, expire] = useState(0);
  const entity = controller.snapshot.snapshots.find(({ environment }) =>
    environment.id === "local" ? !threadId.startsWith("bot:") : threadId.startsWith(environment.id),
  );
  const data = entity?.data;
  const thread = library.threads.find((value) => value.id === threadId);
  const usable = entity?.environment.status === "connected" && thread?.archivedAt === undefined;
  const plans =
    data?.schedules.filter((plan) => plan.threadId === threadId && plan.deletedAt === undefined) ??
    [];
  const proposals =
    data?.proposals
      .filter((proposal) => proposal.threadId === threadId)
      .toSorted((a, b) => b.createdAt - a.createdAt) ?? [];
  const pending = data?.requests.filter((request) => request.threadId === threadId) ?? [];
  const nextExpiry = proposals
    .filter((proposal) => proposal.state === "pending" && proposal.expiresAt > Date.now())
    .reduce((at, proposal) => Math.min(at, proposal.expiresAt), Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(
      () => expire((value) => value + 1),
      Math.min(2_147_483_647, Math.max(0, nextExpiry - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  useEffect(() => {
    setEdit(undefined);
    setHistory(undefined);
    setError(undefined);
  }, [threadId]);
  const act = async (key: string, action: Parameters<SchedulesController["mutate"]>[1]) => {
    setBusy(true);
    setError(undefined);
    try {
      await controller.mutate(key, action, threadId);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法处理定时任务");
    } finally {
      setBusy(false);
    }
  };
  const changeState = (plan: Schedule, action: "pause" | "resume" | "delete") =>
    void act(JSON.stringify([plan.id, plan.revision, action]), (requestId) =>
      window.eta.writeSchedule({
        threadId,
        requestId,
        change: { action, scheduleId: plan.id, expectedRevision: plan.revision },
      }),
    );
  return (
    <ScrollArea className="flex-1">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="truncate text-xs">{thread?.title || "当前会话"}</span>
        <Button variant="ghost" size="compact" disabled={busy || !usable} onClick={onCreate}>
          添加任务
        </Button>
      </div>
      {creating || edit ? (
        <ScheduleForm
          key={`${threadId}:${edit?.schedule?.id ?? edit?.proposal?.id ?? "new"}`}
          library={library}
          controller={controller}
          threadId={threadId}
          workspaceId={thread?.workspaceId}
          schedule={edit?.schedule}
          proposal={edit?.proposal}
          onCancel={() => {
            setEdit(undefined);
            onDone();
          }}
          onSaved={() => {
            setEdit(undefined);
            onDone();
          }}
        />
      ) : (
        <div className="flex flex-col gap-3 px-3 pb-3 text-xs">
          {!usable && <p>{entity?.environment.message ?? "会话已归档或工作区不可用"}</p>}
          {(error || controller.error) && (
            <p role="alert">
              {error ?? controller.error}
              <Button variant="ghost" size="sm" onClick={() => void controller.refresh()}>
                重新加载
              </Button>
            </p>
          )}
          {pending.map((request) => (
            <p key={request.requestId}>
              正在处理：{request.reason ?? "正在核对提交结果"}。已生效计划状态保持不变。
            </p>
          ))}
          {data?.lifecycleIntents
            .filter((intent) => intent.threadId === threadId)
            .map((intent) => (
              <p key={intent.requestId}>
                正在处理会话{intent.action === "archive" ? "归档" : "删除"}。
              </p>
            ))}
          {plans.map((plan) => (
            <section key={plan.id} className="flex flex-col gap-1 border-b border-neutral-200 pb-3">
              <p className="font-medium">
                {plan.name} · {scheduleStates[plan.state]}
              </p>
              <p className="whitespace-pre-wrap break-words">{plan.prompt}</p>
              <p>{scheduleRuleText(plan.rule)}</p>
              <p>下一次：{scheduleTime(plan.nextRunAt)}</p>
              {plan.blockedReason && <p>阻塞：{plan.blockedReason}</p>}
              <div className="flex flex-wrap gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !usable || pending.length > 0}
                  onClick={() => setEdit({ schedule: plan })}
                >
                  编辑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !usable || pending.length > 0}
                  onClick={() => changeState(plan, plan.state === "active" ? "pause" : "resume")}
                >
                  {plan.state === "active" ? "暂停" : "恢复"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !usable || pending.length > 0}
                  onClick={() =>
                    void act(JSON.stringify([plan.id, plan.revision, "run"]), (requestId) =>
                      window.eta.runSchedule({
                        threadId,
                        requestId,
                        scheduleId: plan.id,
                        expectedRevision: plan.revision,
                      }),
                    )
                  }
                >
                  运行一次
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !usable || pending.length > 0}
                  onClick={() => changeState(plan, "delete")}
                >
                  删除
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setHistory(history === plan.id ? undefined : plan.id)}
                >
                  历史
                </Button>
              </div>
              <p className="text-neutral-500">
                暂停或删除仅停止后续触发；已开始的运行可在聊天中停止。
              </p>
              {(data?.occurrences ?? [])
                .filter((run) => run.scheduleId === plan.id)
                .toSorted((a, b) => b.scheduledAt - a.scheduledAt)
                .slice(0, history === plan.id ? 100 : 1)
                .map((run) => (
                  <p key={run.id}>
                    {runStates[run.state]} · {scheduleTime(run.scheduledAt)}
                    {run.source === "manual" ? " · 手动" : ""}
                    {run.reason ? ` · ${run.reason}` : ""}
                  </p>
                ))}
            </section>
          ))}
          {proposals.map((proposal) => {
            const valid =
              proposal.state === "pending" &&
              proposal.expiresAt > Date.now() &&
              !proposal.decisionRequestId;
            const targetId =
              proposal.change.action === "create" ? undefined : proposal.change.scheduleId;
            const current = data?.schedules.find((plan) => plan.id === targetId);
            const next =
              proposal.change.action === "create"
                ? proposal.change
                : proposal.change.action === "update"
                  ? { ...current, ...proposal.change.patch }
                  : current;
            const editableContent =
              proposal.change.action === "create" || proposal.change.action === "update";
            const names = {
              create: "创建",
              update: "修改",
              pause: "暂停",
              resume: "恢复",
              delete: "删除",
            };
            const workspace = library.workspaces.find((item) => item.id === proposal.workspaceId);
            const project = library.projects.find((item) => item.id === workspace?.projectId);
            return (
              <section
                key={proposal.id}
                className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[10px] text-neutral-400">
                      {names[proposal.change.action]}提案
                    </p>
                    <p className="mt-0.5 break-words text-[13px] font-medium text-neutral-800">
                      {next?.name ?? current?.name ?? "定时任务"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                    {valid
                      ? "待确认"
                      : proposal.state === "pending"
                        ? "已过期或处理中"
                        : proposal.state === "approved"
                          ? "已批准"
                          : proposal.state === "rejected"
                            ? "已拒绝"
                            : "已失效"}
                  </span>
                </div>
                {current && (
                  <div className="flex flex-col gap-1 border-l-2 border-neutral-200 pl-2 text-neutral-500">
                    <p>
                      当前：{current.name} · {scheduleStates[current.state]}
                    </p>
                    <PromptPreview text={current.prompt} />
                    <p>{scheduleRuleText(current.rule)}</p>
                  </div>
                )}
                {editableContent ? (
                  <PromptPreview text={next?.prompt ?? ""} />
                ) : (
                  <p className="text-neutral-700">
                    拟变更：
                    {proposal.change.action === "delete"
                      ? "删除计划，仅停止后续触发"
                      : `${names[proposal.change.action]}后续执行`}
                  </p>
                )}
                <div className="flex flex-col gap-1.5 text-[11px] text-neutral-500">
                  {next?.rule && (
                    <p className="flex items-center gap-1.5">
                      <Clock3 size={13} aria-hidden="true" />
                      <span>{scheduleRuleText(next.rule)}</span>
                    </p>
                  )}
                  <p className="flex items-center gap-1.5">
                    {entity?.environment.id === "local" ? (
                      <Monitor size={13} aria-label="本地" />
                    ) : (
                      <Cloud size={13} aria-label="云端" />
                    )}
                    <span className="truncate">{project?.name ?? "工作区不可用"}</span>
                  </p>
                  <p className="flex items-center gap-1.5">
                    <Hourglass size={13} aria-hidden="true" />
                    <span>确认截止 {scheduleTime(proposal.expiresAt)}</span>
                  </p>
                </div>
                {proposal.reason && (
                  <p className="text-[11px] text-neutral-500">{proposal.reason}</p>
                )}
                {valid && (
                  <div className="flex flex-wrap gap-1 border-t border-neutral-100 pt-2">
                    <Button
                      size="compact"
                      disabled={busy || !usable}
                      onClick={() =>
                        void act(
                          `${proposal.id}:approve:${proposal.contentFingerprint}`,
                          (requestId) =>
                            window.eta.decideSchedule(
                              {
                                proposalId: proposal.id,
                                contentFingerprint: proposal.contentFingerprint,
                                requestId,
                              },
                              true,
                            ),
                        )
                      }
                    >
                      批准
                    </Button>
                    <Button
                      variant="ghost"
                      size="compact"
                      disabled={busy || entity?.environment.status !== "connected"}
                      onClick={() =>
                        void act(
                          `${proposal.id}:reject:${proposal.contentFingerprint}`,
                          (requestId) =>
                            window.eta.decideSchedule(
                              {
                                proposalId: proposal.id,
                                contentFingerprint: proposal.contentFingerprint,
                                requestId,
                              },
                              false,
                            ),
                        )
                      }
                    >
                      拒绝
                    </Button>
                    {editableContent && (
                      <Button
                        variant="ghost"
                        size="compact"
                        disabled={busy || !usable}
                        onClick={() => setEdit({ proposal, schedule: current })}
                      >
                        修改
                      </Button>
                    )}
                  </div>
                )}
              </section>
            );
          })}
          {(data?.occurrences ?? [])
            .filter(
              (run) =>
                run.threadId === threadId &&
                !plans.some((plan) => plan.id === run.scheduleId) &&
                ["admitted", "dispatching"].includes(run.state),
            )
            .map((run) => (
              <p key={run.id}>
                {run.name} · {runStates[run.state]} · {scheduleTime(run.scheduledAt)}
              </p>
            ))}
          {!plans.length && !proposals.length && <p>当前会话暂无定时任务</p>}
        </div>
      )}
    </ScrollArea>
  );
}

function PromptPreview({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 80 || text.includes("\n");
  return (
    <div>
      <p
        className={`whitespace-pre-wrap break-words text-xs leading-5 text-neutral-700 ${long && !expanded ? "line-clamp-3" : ""}`}
      >
        {text}
      </p>
      {long && (
        <div className="mt-0.5">
          <Button
            variant="ghost-muted"
            size="compact"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "收起内容" : "查看全文"}
          </Button>
        </div>
      )}
    </div>
  );
}
