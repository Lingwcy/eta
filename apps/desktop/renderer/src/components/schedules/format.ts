import type { ScheduleRule } from "@eta/core/shared/schedules";
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
const calendarDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400_000;
export function scheduleTime(value: number | null, now = Date.now()) {
  if (value === null) return "无后续执行";
  const date = new Date(value);
  const today = new Date(now);
  const distance = calendarDay(date) - calendarDay(today);
  const relative = new Map([
    [-2, "前天"],
    [-1, "昨天"],
    [0, "今天"],
    [1, "明天"],
    [2, "后天"],
  ]);
  const label =
    relative.get(distance) ??
    (Math.abs(distance) < 7
      ? `周${weekdays[date.getDay()]}`
      : date.toLocaleDateString("zh-CN", {
          ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
          month: "numeric",
          day: "numeric",
        }));
  const time = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${label} ${time}`;
}
export function scheduleRuleText(rule: ScheduleRule) {
  switch (rule.type) {
    case "once":
      return `一次 · ${scheduleTime(rule.at)}`;
    case "interval":
      return rule.everyMs % 3600_000 === 0
        ? `每 ${rule.everyMs / 3600_000} 小时`
        : `每 ${rule.everyMs / 60_000} 分钟`;
    case "daily":
      return `每天 ${rule.time}`;
    case "weekly":
      return `周${rule.weekdays.map((day) => weekdays[day]).join("、")} ${rule.time}`;
  }
}
export const scheduleStates = { active: "已启用", paused: "已暂停", completed: "已完成" };
export const runStates = {
  pending: "等待投递",
  dispatching: "核对提交",
  admitted: "已开始",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};
