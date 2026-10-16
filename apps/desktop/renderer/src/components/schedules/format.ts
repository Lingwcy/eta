import { t, currentFormatLocale } from "@/i18n";
import type { ScheduleRule } from "@eta/core/shared/schedules";
const weekdays = () => [
  t("schedules:format.sun"),
  t("schedules:format.mon"),
  t("schedules:format.tue"),
  t("schedules:format.wed"),
  t("schedules:format.thu"),
  t("schedules:format.fri"),
  t("schedules:format.sat"),
];
const calendarDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400_000;
export function scheduleTime(value: number | null, now = Date.now()) {
  if (value === null) return t("schedules:format.noFutureRuns");
  const date = new Date(value);
  const today = new Date(now);
  const distance = calendarDay(date) - calendarDay(today);
  const relative = new Map([
    [-2, t("schedules:format.theDayBeforeYesterday")],
    [-1, t("schedules:format.yesterday")],
    [0, t("schedules:format.today")],
    [1, t("schedules:format.tomorrow")],
    [2, t("schedules:format.theDayAfterTomorrow")],
  ]);
  const label =
    relative.get(distance) ??
    (Math.abs(distance) < 7
      ? t("schedules:format.label", { value1: weekdays()[date.getDay()] })
      : date.toLocaleDateString(currentFormatLocale(), {
          ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
          month: "numeric",
          day: "numeric",
        }));
  const time = date.toLocaleTimeString(currentFormatLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${label} ${time}`;
}
export function scheduleRuleText(rule: ScheduleRule) {
  switch (rule.type) {
    case "once":
      return t("schedules:format.once", { value1: scheduleTime(rule.at) });
    case "interval":
      return rule.everyMs % 3600_000 === 0
        ? t("schedules:format.everyHours", { count: rule.everyMs / 3600_000 })
        : t("schedules:format.everyMinutes", { count: rule.everyMs / 60_000 });
    case "daily":
      return t("schedules:format.dailyAt", { time: rule.time });
    case "weekly":
      return t("schedules:format.weeklyOnAt", {
        value1: rule.weekdays.map((day) => weekdays()[day]).join(t("schedules:format.separator")),
        time: rule.time,
      });
  }
}
export const scheduleStates = () => ({
  active: t("schedules:format.enabled"),
  paused: t("schedules:format.paused"),
  completed: t("schedules:format.completed"),
});
export const runStates = () => ({
  pending: t("schedules:format.waitingForDelivery"),
  dispatching: t("schedules:format.reconcilingSubmission"),
  admitted: t("schedules:format.started"),
  succeeded: t("schedules:format.succeeded"),
  failed: t("schedules:format.failed"),
  cancelled: t("schedules:format.cancelled"),
  skipped: t("schedules:format.skipped"),
});
