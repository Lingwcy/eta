import type { ScheduleRule } from "@eta/core/shared/schedules";
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
export const scheduleTime = (value: number | null) =>
  value === null ? "无后续执行" : new Date(value).toLocaleString();
export function scheduleRuleText(rule: ScheduleRule) {
  switch (rule.type) {
    case "once":
      return `一次 · ${scheduleTime(rule.at)}`;
    case "interval":
      return rule.everyMs % 3600_000 === 0
        ? `每 ${rule.everyMs / 3600_000} 小时`
        : `每 ${rule.everyMs / 60_000} 分钟`;
    case "daily":
      return `每天 ${rule.time} · ${rule.timeZone}`;
    case "weekly":
      return `周${rule.weekdays.map((day) => weekdays[day]).join("、")} ${rule.time} · ${rule.timeZone}`;
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
