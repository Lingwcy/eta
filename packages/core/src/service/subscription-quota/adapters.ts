import type { QuotaWindow } from "../../shared/subscription-quota.ts";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function number(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function validDate(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
}

function percent(value: unknown) {
  const n = number(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}

export function codexWindows(value: unknown, now: number): QuotaWindow[] {
  const rate = object(object(value)?.rate_limit);
  if (!rate) throw new Error("invalid response");
  return ["primary", "secondary"].flatMap((id) => {
    const raw = rate[`${id}_window`];
    if (raw === undefined || raw === null) return [];
    const row = object(raw);
    if (!row) throw new Error("invalid window");
    const usedPercent = percent(row.used_percent);
    if (usedPercent === undefined) throw new Error("invalid window");
    const seconds = number(row.limit_window_seconds);
    const resetAt = number(row.reset_at);
    const resetAfter = number(row.reset_after_seconds);
    const resetsAt =
      resetAt !== undefined && resetAt > 0
        ? resetAt * 1000
        : resetAfter !== undefined && resetAfter > 0
          ? now + resetAfter * 1000
          : undefined;
    return [
      {
        id,
        name: id,
        usedPercent,
        ...(seconds !== undefined && seconds > 0 ? { windowMinutes: seconds / 60 } : {}),
        ...(validDate(resetsAt) ? { resetsAt } : {}),
      },
    ];
  });
}

export function copilotWindows(value: unknown): QuotaWindow[] {
  const root = object(value);
  const snapshots = object(root?.quota_snapshots);
  if (!root || !snapshots) throw new Error("invalid response");
  const resetText =
    typeof root.quota_reset_date_utc === "string"
      ? root.quota_reset_date_utc
      : root.quota_reset_date;
  const defaultReset = typeof resetText === "string" ? Date.parse(resetText) : NaN;
  return ["chat", "completions", "premium_interactions"].flatMap<QuotaWindow>((id) => {
    const raw = snapshots[id];
    if (raw === undefined || raw === null) return [];
    const row = object(raw);
    if (!row) throw new Error("invalid window");
    const reset = number(row.quota_reset_at);
    const resetsAt =
      reset !== undefined && reset > 0
        ? reset * 1000
        : Number.isFinite(defaultReset)
          ? defaultReset
          : undefined;
    const common = { id, name: id, ...(validDate(resetsAt) ? { resetsAt } : {}) };
    if (row.unlimited === true) {
      if (id === "premium_interactions" && row.has_quota === false)
        return [{ ...common, usedPercent: 100 }];
      return [{ ...common, unlimited: true }];
    }
    const total = number(row.entitlement);
    const remaining = number(row.quota_remaining);
    if (total !== undefined && total > 0 && remaining !== undefined && remaining >= 0)
      return [{ ...common, total, remaining }];
    if (total !== undefined && total <= 0) return [];
    const p = percent(row.percent_remaining);
    if (p === undefined) throw new Error("invalid window");
    return [{ ...common, usedPercent: 100 - p }];
  });
}
