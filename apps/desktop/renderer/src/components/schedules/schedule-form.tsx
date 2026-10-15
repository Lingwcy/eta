import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import type { Schedule, ScheduleChange } from "@eta/core/shared/schedules";
import { ScheduleRuleSchema } from "@eta/core/shared/schedules";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SchedulesController } from "@/agent/use-schedules";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X, ChevronDown, ChevronUp, Monitor, Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SandboxPicker } from "@/components/input/sandbox-picker";
import { sandboxModes, type SandboxMode } from "@eta/core/shared/sandbox";
import { ModelPicker } from "@/components/input/model-picker";
import { defaultModel } from "@/desktop/selectors";
import type { InputModel } from "@/components/input/types";
import type { ThinkingLevel } from "@eta/core/agent/protocol";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScheduleTimePicker } from "./schedule-time-picker";
import { ScheduleDatePicker } from "./schedule-date-picker";

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
  onCancel,
  onSaved,
}: {
  library: DesktopLibrary;
  controller: SchedulesController;
  threadId?: string;
  workspaceId?: string;
  schedule?: Schedule;
  onCancel(this: void): void;
  onSaved(this: void, threadId: string): void;
}) {
  const initialRule = schedule?.rule;
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
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
  const [zone] = useState(() =>
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
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("danger-full-access");
  const [permissionChanged, setPermissionChanged] = useState(false);
  const [threadModes, setThreadModes] = useState<readonly SandboxMode[]>();
  const allowedModes =
    threadModes ??
    (workspace.startsWith("bot:")
      ? (library.bot?.library?.allowedSandboxModes ?? [])
      : sandboxModes);
  const effectiveSandboxMode = allowedModes.includes(sandboxMode)
    ? sandboxMode
    : allowedModes.includes("workspace-write")
      ? "workspace-write"
      : (allowedModes[0] ?? sandboxMode);
  const [loadingModel, setLoadingModel] = useState(!!threadId);
  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    void window.eta
      .openThread(threadId)
      .then((session) => {
        if (disposed) return;
        setModel(session.model);
        setLevel(session.snapshot.configuration.thinkingLevel);
        if (session.snapshot.sandbox) {
          setSandboxMode(session.snapshot.sandbox.mode);
          setThreadModes(session.snapshot.sandbox.allowedModes);
        }
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
  }, [threadId]);
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
      if (!available || !allowedModes.length) throw new Error("执行环境不可用，请重新连接后重试");
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
                    sandboxMode: effectiveSandboxMode,
                  }
                : undefined,
            )
          ).id;
        id = draft.current.threadId;
        await window.eta.renameThread(id, name);
      }
      const target = id;
      if (!threadId || permissionChanged)
        await window.eta.configureSandbox(target, effectiveSandboxMode);
      if (modelChanged && model)
        await window.eta.configureThread(target, model.provider, model.id, level);
      const input: ScheduleChange = schedule
        ? {
            action: "update",
            scheduleId: schedule.id,
            expectedRevision: schedule.revision,
            patch: { name, prompt, rule },
          }
        : { action: "create", name, prompt, rule };
      const key = JSON.stringify({ target, input });
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
      <DialogContent variant="dense-form">
        <form
          aria-label={schedule ? "编辑定时任务" : "新建定时任务"}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex min-h-0 flex-col gap-3 overflow-y-auto text-xs"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-medium">
              {schedule ? "编辑定时任务" : "设置定时任务"}
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
            <div className="mt-1 rounded-lg border border-neutral-200 bg-white p-2.5 focus-within:border-neutral-400 focus-within:ring-2 focus-within:ring-neutral-200">
              <Textarea
                variant="compact"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                disabled={busy}
              />
            </div>
          </label>
          <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-2.5">
            <div className="grid grid-cols-2 items-start gap-3">
              <label className="flex min-w-0 flex-col gap-1">
                重复
                <Select
                  size="compact"
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
              </label>
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
                    variant="compact"
                    type="number"
                    min={5}
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              {(kind === "daily" || kind === "weekly") && (
                <label className="flex flex-col gap-1">
                  执行时间
                  <ScheduleTimePicker value={time} onChange={setTime} disabled={busy} />
                </label>
              )}
            </div>
            {kind === "weekly" && (
              <fieldset className="flex items-center gap-3">
                <legend className="sr-only">星期</legend>
                <span className="shrink-0 text-neutral-500">星期</span>
                <div className="grid min-w-0 flex-1 grid-cols-7 gap-1">
                  {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => (
                    <Button
                      key={day}
                      variant="ghost"
                      size="compact"
                      selected={days.includes(index)}
                      aria-label={`星期${day}`}
                      aria-pressed={days.includes(index)}
                      disabled={busy}
                      onClick={() =>
                        setDays(
                          days.includes(index)
                            ? days.filter((value) => value !== index)
                            : [...days, index].toSorted((a, b) => a - b),
                        )
                      }
                    >
                      {day}
                    </Button>
                  ))}
                </div>
              </fieldset>
            )}
          </section>
          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger variant="ghost-muted" size="compact">
              高级 {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="pt-2">
                <section className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white p-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {threadId ? (
                        <div className="flex items-center gap-2">
                          {workspaceIcon(workspace)}
                          <span>{workspaceLabel(workspace)}</span>
                        </div>
                      ) : (
                        <Select
                          label="执行工作区"
                          variant="menu"
                          popupSizing="content"
                          size="compact"
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
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-neutral-500">权限</span>
                      <SandboxPicker
                        mode={effectiveSandboxMode}
                        defaultMode="danger-full-access"
                        allowedModes={allowedModes}
                        disabled={busy || loadingModel}
                        side="bottom"
                        onChange={(mode) => {
                          setSandboxMode(mode);
                          setPermissionChanged(true);
                        }}
                      />
                    </div>
                  </div>
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
                </section>
              </div>
            </CollapsibleContent>
          </Collapsible>

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
            <Button
              size="compact"
              type="submit"
              disabled={busy || !available || loadingModel || !allowedModes.length}
            >
              {busy ? "正在处理" : schedule ? "保存" : "创建"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
