import { renderMessage } from "@/i18n/messages";
import { LocalizedError, describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
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
  useTranslation();
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
  const [error, setError] = useState<Message>();
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
        if (!disposed)
          setError(
            describeError(error, localizedMessage("schedules:scheduleForm.cannotLoadTheChatModel")),
          );
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
    return (
      library.projects.find((project) => project.id === item?.projectId)?.name ??
      t("schedules:scheduleForm.unnamedProject")
    );
  };
  const workspaceIcon = (id: string) => (
    <span
      role="img"
      aria-label={
        id.startsWith("bot:")
          ? t("schedules:scheduleForm.cloud")
          : t("schedules:scheduleForm.local")
      }
    >
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
  const environment = controller.snapshot.snapshots.find(({ environment }) =>
    environment.id === "local"
      ? !workspace.startsWith("bot:")
      : workspace.startsWith(environment.id),
  )?.environment;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!available || !allowedModes.length)
        throw new LocalizedError(
          "schedules:scheduleForm.theEnvironmentIsUnavailableReconnectAndTry",
        );
      if (!name.trim() || !prompt.trim())
        throw new LocalizedError("schedules:scheduleForm.enterATaskTitleAndInstructions");
      if (kind === "once" && !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(at))
        throw new LocalizedError("schedules:scheduleForm.enterAValidTimeInHhMm");
      const rule = Schema.decodeUnknownSync(ScheduleRuleSchema)(
        kind === "once"
          ? {
              type: kind,
              at:
                initialRule?.type === "once" && at === localDate(initialRule.at)
                  ? initialRule.at
                  : new Date(at).getTime(),
            }
          : kind === "interval"
            ? {
                type: kind,
                everyMs:
                  initialRule?.type === "interval" &&
                  minutes === String(initialRule.everyMs / 60_000)
                    ? initialRule.everyMs
                    : Number(minutes) * 60_000,
                anchorAt: anchor,
              }
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
      setError(
        describeError(error, localizedMessage("schedules:scheduleForm.cannotSaveTheScheduledTask")),
      );
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
          aria-label={
            schedule
              ? t("schedules:scheduleForm.editScheduledTask")
              : t("schedules:scheduleForm.newScheduledTask")
          }
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="flex min-h-0 flex-col gap-3 overflow-y-auto text-xs"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-base font-medium">
              {schedule
                ? t("schedules:scheduleForm.editScheduledTask")
                : t("schedules:scheduleForm.setUpScheduledTask")}
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("schedules:scheduleForm.closeScheduledTask")}
              disabled={busy}
              onClick={onCancel}
            >
              <X size={16} />
            </Button>
          </div>
          <label>
            {t("schedules:scheduleForm.taskTitle")}
            <Input
              variant="compact"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            {t("schedules:scheduleForm.instructions")}
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
                {t("schedules:scheduleForm.repeat")}
                <Select
                  size="compact"
                  label={t("schedules:scheduleForm.repeat")}
                  value={kind}
                  options={[
                    { value: "once", label: t("schedules:scheduleForm.once") },
                    { value: "interval", label: t("schedules:scheduleForm.atAnInterval") },
                    { value: "daily", label: t("schedules:scheduleForm.daily") },
                    { value: "weekly", label: t("schedules:scheduleForm.weekly") },
                  ]}
                  onValueChange={setKind}
                  disabled={busy}
                />
              </label>
              {kind === "once" && (
                <label>
                  {t("schedules:scheduleForm.localTime")}
                  <ScheduleDatePicker value={at} onChange={setAt} disabled={busy} />
                </label>
              )}
              {kind === "interval" && (
                <label>
                  {t("schedules:scheduleForm.intervalMinutesAtLeast5")}
                  <Input
                    variant="compact"
                    type="number"
                    min={5}
                    step="any"
                    value={minutes}
                    onChange={(event) => setMinutes(event.target.value)}
                    disabled={busy}
                  />
                </label>
              )}
              {(kind === "daily" || kind === "weekly") && (
                <label className="flex flex-col gap-1">
                  {t("schedules:scheduleForm.runTime")}
                  <ScheduleTimePicker value={time} onChange={setTime} disabled={busy} />
                </label>
              )}
            </div>
            {kind === "weekly" && (
              <fieldset className="flex items-center gap-3">
                <legend className="sr-only">{t("schedules:scheduleForm.daysOfTheWeek")}</legend>
                <span className="shrink-0 text-neutral-500">
                  {t("schedules:scheduleForm.daysOfTheWeek")}
                </span>
                <div className="grid min-w-0 flex-1 grid-cols-7 gap-1">
                  {[
                    t("schedules:scheduleForm.sun"),
                    t("schedules:scheduleForm.mon"),
                    t("schedules:scheduleForm.tue"),
                    t("schedules:scheduleForm.wed"),
                    t("schedules:scheduleForm.thu"),
                    t("schedules:scheduleForm.fri"),
                    t("schedules:scheduleForm.sat"),
                  ].map((day, index) => (
                    <Button
                      key={day}
                      variant="ghost"
                      size="compact"
                      selected={days.includes(index)}
                      aria-label={t("schedules:scheduleForm.label", { day: day })}
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
              {t("schedules:scheduleForm.advanced")}
              {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
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
                          label={t("schedules:scheduleForm.executionWorkspace")}
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
                      <span className="text-neutral-500">
                        {t("schedules:scheduleForm.permissions")}
                      </span>
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
                    <span>{t("schedules:scheduleForm.modelAndThinkingLevel")}</span>
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
              {(environment?.messageKey
                ? t(environment.messageKey, { defaultValue: environment.message ?? "" })
                : environment?.message) ??
                t("schedules:scheduleForm.loadingTheEnvironmentOrTheWorkspaceIs")}
            </p>
          )}
          {(error || controller.error) && (
            <p role="alert">{renderMessage(error ?? controller.error)}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost-muted"
              size="compact"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              {t("schedules:scheduleForm.cancel")}
            </Button>
            <Button
              size="compact"
              type="submit"
              disabled={busy || !available || loadingModel || !allowedModes.length}
            >
              {busy
                ? t("schedules:scheduleForm.processing")
                : schedule
                  ? t("schedules:scheduleForm.save")
                  : t("schedules:scheduleForm.create")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
