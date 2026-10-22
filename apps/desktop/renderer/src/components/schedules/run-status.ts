import { t } from "@/i18n";
import type { Schedule, ScheduleOccurrence } from "@eta/core/shared/schedules";
import type { ScheduleEnvironment } from "../../../../src/shared/schedules.ts";

function blockingReason(reason: string) {
  switch (reason) {
    case "busy":
    case "Busy":
      return t("schedules:runStatus.busy");
    case "recoveryRequired":
    case "RecoveryRequired":
      return t("schedules:runStatus.recoveryRequired");
    case "projectBlocked":
      return t("schedules:runStatus.projectBlocked");
    case "workspaceUnavailable":
    case "WorkspaceUnavailable":
      return t("schedules:runStatus.workspaceUnavailable");
    case "runtimeClosing":
    case "RuntimeClosing":
      return t("schedules:runStatus.runtimeClosing");
    case "admissionUnknown":
    case "admissionNotFound":
      return t("schedules:runStatus.reconciling");
    default:
      return t("schedules:runStatus.blockedReason", { reason });
  }
}

/** Admission is durable even when a host restarts; a blocked receipt is not live execution. */
export function scheduleRunStatus(
  runs: readonly ScheduleOccurrence[],
  plans: readonly Schedule[],
  environment: ScheduleEnvironment,
) {
  const ordered = runs.toSorted((a, b) => b.scheduledAt - a.scheduledAt);
  const current =
    ordered.find((run) => run.state === "admitted") ??
    ordered.find((run) => run.state === "dispatching") ??
    ordered.find((run) => run.state === "pending");
  if (environment.status !== "connected")
    return {
      state: "offline" as const,
      label: t("schedules:runStatus.offline"),
      detail: t("schedules:runStatus.offlineDetail"),
    };
  if (current) {
    const reason =
      current.reason ??
      (current.state === "pending"
        ? plans.find((plan) => plan.id === current.scheduleId)?.blockedReason
        : undefined);
    if (reason)
      return {
        state: "blocked" as const,
        label: t("schedules:scheduleSidebar.waitingToRun"),
        detail: blockingReason(reason),
      };
    return current.state === "admitted"
      ? { state: "running" as const, label: t("schedules:scheduleSidebar.running") }
      : {
          state: "waiting" as const,
          label: t("schedules:scheduleSidebar.waitingToRun"),
          detail:
            current.state === "dispatching"
              ? t("schedules:runStatus.reconciling")
              : t("schedules:runStatus.queued"),
        };
  }
  const latest = ordered[0];
  if (latest?.state === "succeeded")
    return { state: "succeeded" as const, label: t("schedules:scheduleSidebar.runSucceeded") };
  if (latest?.state === "failed")
    return {
      state: "failed" as const,
      label: t("schedules:scheduleSidebar.chatError"),
      detail: latest.reason,
    };
  if (latest?.state === "cancelled" || latest?.state === "skipped")
    return {
      state: latest.state,
      label: t(
        latest.state === "cancelled" ? "schedules:format.cancelled" : "schedules:format.skipped",
      ),
      detail:
        latest.reason === "aborted"
          ? t("navigation:conversationPanel.generationStopped")
          : undefined,
    };
  return undefined;
}
