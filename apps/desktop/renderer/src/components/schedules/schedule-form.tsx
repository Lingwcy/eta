import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import type { Schedule, ScheduleChange, ScheduleProposal } from "@eta/core/shared/schedules";
import { ScheduleRuleSchema } from "@eta/core/shared/schedules";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SchedulesController } from "@/agent/use-schedules";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X, ChevronDown, ChevronUp, Monitor, Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ModelPicker } from "@/components/input/model-picker";
import { defaultModel } from "@/desktop/selectors";
import type { InputModel } from "@/components/input/types";
import type { ThinkingLevel } from "@eta/core/agent/protocol";
import { ScheduleDatePicker } from "./schedule-date-picker";
import { scheduleRuleText } from "./format";

const localDate = (time: number) => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
export function ScheduleForm({
  library,
  controller,
  threadId,
  workspaceId,
  schedule,
  proposal,
  onCancel,
  onSaved,
}: {
  library: DesktopLibrary;
  controller: SchedulesController;
  threadId?: string;
  workspaceId?: string;
  schedule?: Schedule;
  proposal?: ScheduleProposal;
  onCancel(this: void): void;
  onSaved(this: void, threadId: string): void;
}) {
  const change = proposal?.change;
  const initialRule =
    change?.action === "create"
      ? change.rule
      : change?.action === "update"
        ? (change.patch.rule ?? schedule?.rule)
        : schedule?.rule;
  const [name, setName] = useState(
    change?.action === "create"
      ? change.name
      : change?.action === "update"
        ? (change.patch.name ?? schedule?.name ?? "")
        : (schedule?.name ?? ""),
  );
  const [prompt, setPrompt] = useState(
    change?.action === "create"
      ? change.prompt
      : change?.action === "update"
        ? (change.patch.prompt ?? schedule?.prompt ?? "")
        : (schedule?.prompt ?? ""),
  );
  const [workspace, setWorkspace] = useState(workspaceId ?? library.workspaces[0]?.id ?? "");
  const [kind, setKind] = useState(initialRule?.type ?? "once");
  const [at, setAt] = useState(
    localDate(initialRule?.type === "once" ? initialRule.at : Date.now() + 3600_000),
  );
  const [anchor] = useState(initialRule?.type === "interval" ? initialRule.anchorAt : Date.now());
  const [minutes, setMinutes] = useState(
    initialRule?.type === "interval" ? String(initialRule.everyMs / 60_000) : "60",
  );
  const [time, setTime] = useState(
    initialRule?.type === "daily" || initialRule?.type === "weekly" ? initialRule.time : "09:00",
  );
  const [zone, setZone] = useState(
    initialRule?.type === "daily" || initialRule?.type === "weekly"
      ? initialRule.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [days, setDays] = useState<readonly number[]>(
    initialRule?.type === "weekly" ? initialRule.weekdays : [1],
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [model, setModel] = useState<InputModel | undefined>(() =>
    threadId ? undefined : defaultModel(library),
  );
  const [level, setLevel] = useState<ThinkingLevel>(library.settings.defaultThinkingLevel);
  const [modelChanged, setModelChanged] = useState(false);
  const [loadingModel, setLoadingModel] = useState(!!threadId && !proposal);
  useEffect(() => {
    if (!threadId || proposal) return;
    let disposed = false;
    void window.eta
      .openThread(threadId)
      .then((session) => {
        if (disposed) return;
        setModel(session.model);
        setLevel(session.snapshot.configuration.thinkingLevel);
      })
      .catch((error: unknown) => {
        if (!disposed) setError(error instanceof Error ? error.message : "无法加载会话模型");
      })
      .finally(() => {
        if (!disposed) setLoadingModel(false);
      });
    return () => {
      disposed = true;
    };
  }, [threadId, proposal]);
  const draft = useRef<{ workspace: string; requestId: string; threadId?: string } | undefined>(
    undefined,
  );
  const workspaceLabel = (id: string) => {
    const item = library.workspaces.find((value) => value.id === id);
    return library.projects.find((project) => project.id === item?.projectId)?.name ?? "未命名项目";
  };
  const workspaceIcon = (id: string) => (
    <span role="img" aria-label={id.startsWith("bot:") ? "云端" : "本地"}>
      {id.startsWith("bot:") ? (
        <Cloud size={15} aria-hidden="true" />
      ) : (
        <Monitor size={15} aria-hidden="true" />
      )}
    </span>
  );
  const available = controller.snapshot.snapshots.some(
    ({ environment, data }) =>
      environment.status === "connected" &&
      (environment.id === "local"
        ? !workspace.startsWith("bot:")
        : workspace.startsWith(environment.id)) &&
      (!threadId || !data.lifecycleIntents.some((intent) => intent.threadId === threadId)),
  );
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!available) throw new Error("执行环境不可用，请重新连接后重试");
      if (!name.trim() || !prompt.trim()) throw new Error("请填写任务标题和执行内容");
      if (kind === "once" && !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(at))
        throw new Error("请填写有效时间，格式为 HH:mm");
      const rule = Schema.decodeUnknownSync(ScheduleRuleSchema)(
        kind === "once"
          ? { type: kind, at: new Date(at).getTime() }
          : kind === "interval"
            ? { type: kind, everyMs: Number(minutes) * 60_000, anchorAt: anchor }
            : {
                type: kind,
                time,
                timeZone: zone,
                ...(kind === "weekly" ? { weekdays: days } : {}),
              },
      );
      let id = threadId;
      if (!id) {
        if (!draft.current || draft.current.workspace !== workspace)
          draft.current = { workspace, requestId: crypto.randomUUID() };
        if (!draft.current.threadId)
          draft.current.threadId = (
            await window.eta.createThread(
              workspace,
              draft.current.requestId,
              model
                ? {
                    provider: model.provider,
                    modelId: model.id,
                    thinkingLevel: level,
                  }
                : undefined,
            )
          ).id;
        id = draft.current.threadId;
        await window.eta.renameThread(id, name);
      }
      const target = id;
      if (modelChanged && model && !proposal)
        await window.eta.configureThread(target, model.provider, model.id, level);
      const input: ScheduleChange = schedule
        ? {
            action: "update",
            scheduleId: schedule.id,
            expectedRevision: schedule.revision,
            patch: { name, prompt, rule },
          }
        : { action: "create", name, prompt, rule };
      const key = JSON.stringify({ target, input, proposal: proposal?.id });
      if (proposal)
        await controller.mutate(
          key,
          (requestId) =>
            window.eta.proposeSchedule({
              threadId: target,
              requestId,
              sourceIdentity: "desktop:proposal-edit",
              change: input,
              replaces: {
                proposalId: proposal.id,
                contentFingerprint: proposal.contentFingerprint,
              },
            }),
          target,
        );
      else
        await controller.mutate(
          key,
          (requestId) => window.eta.writeSchedule({ threadId: target, requestId, change: input }),
          target,
        );
      onSaved(target);
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法保存定时任务");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent variant="form">
        <form
          aria-label={schedule ? "编辑定时任务" : "新建定时任务"}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex min-h-0 flex-col gap-4 overflow-y-auto text-xs"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-medium">
              {proposal ? "修改待确认提案" : schedule ? "编辑定时任务" : "设置定时任务"}
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="关闭定时任务"
              disabled={busy}
              onClick={onCancel}
            >
              <X size={16} />
            </Button>
          </div>
          <label>
            任务标题
            <Input
              variant="compact"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            执行内容
            <div className="mt-1 rounded-lg border border-neutral-200 bg-white p-3 focus-within:border-neutral-400 focus-within:ring-2 focus-within:ring-neutral-200">
              <Textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={busy}
              />
            </div>
          </label>
          <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3">
            <p className="font-medium">重复</p>
            <Select
              label="重复"
              value={kind}
              options={[
                { value: "once", label: "一次" },
                { value: "interval", label: "按间隔" },
                { value: "daily", label: "每天" },
                { value: "weekly", label: "每周" },
              ]}
              onValueChange={setKind}
              disabled={busy}
            />
            {kind === "once" && (
              <label>
                本机时间
                <ScheduleDatePicker value={at} onChange={setAt} disabled={busy} />
              </label>
            )}
            {kind === "interval" && (
              <label>
                间隔（分钟，至少 5）
                <Input
                  type="number"
                  min={5}
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            {(kind === "daily" || kind === "weekly") && (
              <>
                <label>
                  执行时间
                  <Input
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  IANA 时区
                  <Input
                    variant="compact"
                    value={zone}
                    onChange={(event) => setZone(event.target.value)}
                    disabled={busy}
                  />
                </label>
              </>
            )}
            {kind === "weekly" && (
              <fieldset>
                <legend>星期</legend>
                <div className="flex flex-wrap gap-2">
                  {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        checked={days.includes(index)}
                        disabled={busy}
                        onChange={(event) =>
                          setDays(
                            event.target.checked
                              ? [...days, index].toSorted((a, b) => a - b)
                              : days.filter((value) => value !== index),
                          )
                        }
                      />
                      {day}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </section>
          <div>
            <Button
              variant="ghost-muted"
              size="compact"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              高级 {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </Button>
          </div>
          {advanced && (
            <section className="flex flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-3">
              {threadId ? (
                <div className="flex items-center gap-2">
                  {workspaceIcon(workspace)}
                  <span>{workspaceLabel(workspace)}</span>
                </div>
              ) : (
                <Select
                  label="执行工作区"
                  value={workspace}
                  options={library.workspaces.map((item) => ({
                    value: item.id,
                    label: workspaceLabel(item.id),
                    icon: workspaceIcon(item.id),
                  }))}
                  onValueChange={setWorkspace}
                  disabled={busy}
                />
              )}

              {!proposal && (
                <div className="flex items-center justify-between gap-3">
                  <span>模型与强度</span>
                  <ModelPicker
                    model={model}
                    models={library.models}
                    providers={library.providers}
                    thinkingLevel={level}
                    side="bottom"
                    disabled={busy || loadingModel}
                    onChange={(next, thinking) => {
                      setModel(next);
                      setLevel(thinking);
                      setModelChanged(true);
                    }}
                  />
                </div>
              )}
            </section>
          )}
          {initialRule && <p>原规则：{scheduleRuleText(initialRule)}</p>}

          {!available && (
            <p>
              {controller.snapshot.snapshots.find(({ environment }) =>
                environment.id === "local"
                  ? !workspace.startsWith("bot:")
                  : workspace.startsWith(environment.id),
              )?.environment.message ?? "正在加载执行环境，或当前工作区不可用"}
            </p>
          )}
          {(error || controller.error) && <p role="alert">{error ?? controller.error}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost-muted"
              size="compact"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </Button>
            <Button size="compact" type="submit" disabled={busy || !available || loadingModel}>
              {busy ? "正在处理" : proposal ? "提出新提案" : schedule ? "保存" : "创建"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
