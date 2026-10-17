import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { SchedulesController } from "@/agent/use-schedules";
import { scheduleRunStatus } from "./run-status";
import { scheduleTime } from "./format";

export function ScheduleRunNotice({
  threadId,
  controller,
}: {
  threadId?: string | null;
  controller: SchedulesController;
}) {
  useTranslation();
  const scoped = controller.snapshot.snapshots.find(({ data }) =>
    data.schedules.some((plan) => plan.threadId === threadId),
  );
  const run = scoped?.data.occurrences
    ?.filter((run) => run.threadId === threadId && run.source === "manual")
    .toSorted((a, b) => b.scheduledAt - a.scheduledAt)[0];
  if (!scoped || !run) return null;
  const status = scheduleRunStatus([run], scoped.data.schedules, scoped.environment);
  if (!status) return null;
  return (
    <div role="status" aria-live="polite" className="pb-2 text-xs text-neutral-500">
      <p>
        {t("schedules:scheduleMenu.runNow")} · {scheduleTime(run.scheduledAt)} · {status.label}
      </p>
      {status.detail && <p>{status.detail}</p>}
    </div>
  );
}
