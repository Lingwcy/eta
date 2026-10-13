import { useRef, useState } from "react";
import { Schema } from "effect";
import type { Schedule, ScheduleChange, ScheduleProposal } from "@eta/core/shared/schedules";
import { ScheduleRuleSchema } from "@eta/core/shared/schedules";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { SchedulesController } from "@/agent/use-schedules";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
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
  const draft = useRef<{ workspace: string; requestId: string; threadId?: string } | undefined>(
    undefined,
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
            await window.eta.createThread(workspace, draft.current.requestId)
          ).id;
        id = draft.current.threadId;
        await window.eta.renameThread(id, name);
      }
      const target = id;
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
    <form
      aria-label={schedule ? "编辑定时任务" : "新建定时任务"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-3 px-3 py-2 text-xs"
    >
      <p>{proposal ? "修改待确认提案" : schedule ? "编辑任务" : "新建任务"}</p>
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
        <div className="mt-1">
          <Textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy}
          />
        </div>
      </label>
      {threadId ? (
        <p>
          执行环境：
          {library.workspaces.find((item) => item.id === workspace)?.cwd ?? "工作区不可用"}
        </p>
      ) : (
        <Select
          label="执行工作区"
          value={workspace}
          options={library.workspaces.map((item) => ({
            value: item.id,
            label: `${item.id.startsWith("bot:") ? "Bot" : "本地"} · ${item.cwd}`,
          }))}
          onValueChange={setWorkspace}
          disabled={busy}
        />
      )}
      <Select
        label="时间规则"
        value={kind}
        options={[
          { value: "once", label: "一次" },
          { value: "interval", label: "间隔" },
          { value: "daily", label: "每天" },
          { value: "weekly", label: "每周" },
        ]}
        onValueChange={setKind}
        disabled={busy}
      />
      {kind === "once" && (
        <label>
          本机时间
          <Input
            type="datetime-local"
            value={at}
            onChange={(event) => setAt(event.target.value)}
            disabled={busy}
          />
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
      {initialRule && <p>原规则：{scheduleRuleText(initialRule)}</p>}
      <p>任务使用该会话的模型、权限及工作区，可能修改文件并消耗模型额度。</p>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-1">
        <Button size="sm" type="submit" disabled={busy || !available}>
          {busy ? "正在处理" : proposal ? "提出新提案" : "保存"}
        </Button>
        <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
