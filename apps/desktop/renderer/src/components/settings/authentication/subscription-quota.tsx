import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { QuotaWindow } from "@eta/core/shared/subscription-quota";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useSubscriptionQuota } from "@/agent/use-subscription-quota";
import { currentFormatLocale, t } from "@/i18n";

function windowName(window: QuotaWindow) {
  const minutes = window.windowMinutes;
  if (minutes !== undefined && minutes > 0 && minutes % 1440 === 0)
    return t("settings:subscriptionQuota.days", { count: minutes / 1440 });
  if (minutes !== undefined && minutes > 0 && minutes % 60 === 0)
    return t("settings:subscriptionQuota.hours", { count: minutes / 60 });
  if (minutes !== undefined && minutes > 0)
    return t("settings:subscriptionQuota.minutes", { count: minutes });
  switch (window.id) {
    case "primary":
      return t("settings:subscriptionQuota.primary");
    case "secondary":
      return t("settings:subscriptionQuota.secondary");
    case "chat":
      return t("settings:subscriptionQuota.chat");
    case "completions":
      return t("settings:subscriptionQuota.completions");
    case "premium_interactions":
      return t("settings:subscriptionQuota.premium");
    default:
      return window.name;
  }
}

function remaining(window: QuotaWindow) {
  if (window.unlimited) return t("settings:subscriptionQuota.unlimited");
  const format = new Intl.NumberFormat(currentFormatLocale(), { maximumFractionDigits: 1 });
  if (window.remaining !== undefined) {
    const total = window.total === undefined ? "" : " / " + format.format(window.total);
    return t("settings:subscriptionQuota.remaining", {
      value: format.format(window.remaining) + total,
    });
  }
  if (window.usedPercent !== undefined)
    return t("settings:subscriptionQuota.remaining", {
      value: format.format(Math.max(0, 100 - window.usedPercent)) + "%",
    });
  return t("settings:subscriptionQuota.unknown");
}

function resetTime(timestamp: number, now: number) {
  const minutes = (timestamp - now) / 60_000;
  if (minutes <= 0) return t("settings:subscriptionQuota.resetDue");
  const unit = minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute";
  const value = minutes / (unit === "day" ? 1440 : unit === "hour" ? 60 : 1);
  const time = new Intl.RelativeTimeFormat(currentFormatLocale(), { numeric: "always" }).format(
    Math.max(0.1, Math.round(value * 10) / 10),
    unit,
  );
  return t("settings:subscriptionQuota.resets", { time });
}

function fraction(window: QuotaWindow) {
  if (window.unlimited) return 1;
  if (window.remaining !== undefined && window.total !== undefined && window.total > 0)
    return Math.max(0, Math.min(1, window.remaining / window.total));
  if (window.usedPercent !== undefined)
    return Math.max(0, Math.min(1, 1 - window.usedPercent / 100));
  return undefined;
}

const colors = ["text-emerald-500", "text-blue-500", "text-amber-500"];

/** Each window owns a fixed arc; its filled fraction represents the remaining allowance. */
function QuotaRing({
  windows,
  loading,
  error,
}: {
  windows: QuotaWindow[];
  loading: boolean;
  error: boolean;
}) {
  const segments = windows.length || 1;
  const span = 1 / segments - (segments > 1 ? 0.055 : 0);
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {(windows.length ? windows : [undefined]).map((window, index) => {
        const value = window && fraction(window);
        const offset = -(index / segments + (segments > 1 ? 0.0275 : 0));
        const arc = {
          cx: 10,
          cy: 10,
          r: 8,
          pathLength: 1,
          strokeWidth: 2,
          transform: "rotate(-90 10 10)",
          strokeDashoffset: offset,
        };
        return (
          <g key={window?.id ?? "empty"}>
            <circle
              {...arc}
              stroke="currentColor"
              className="text-neutral-200"
              strokeDasharray={span + " " + (1 - span)}
            />
            {value !== undefined && value > 0 && (
              <circle
                {...arc}
                stroke="currentColor"
                className={colors[index % colors.length]}
                strokeDasharray={span * value + " " + (1 - span * value)}
              />
            )}
          </g>
        );
      })}
      {!windows.length && (
        <text
          x="10"
          y="10"
          dominantBaseline="central"
          textAnchor="middle"
          fill="currentColor"
          fontSize="10"
        >
          {loading ? "…" : error ? "!" : "?"}
        </text>
      )}
    </svg>
  );
}

export function SubscriptionQuota({
  providerId,
  connectionId,
}: {
  providerId: string;
  connectionId: string;
}) {
  useTranslation();
  const { quota, loading, failed, refresh } = useSubscriptionQuota(providerId, connectionId);
  const [now, setNow] = useState(() => Date.now());
  const retryAt = quota?.retryAt;
  useEffect(() => {
    setNow(Date.now());
    if (retryAt === undefined || retryAt <= Date.now()) return;
    const timeout = setTimeout(
      () => setNow(Date.now()),
      Math.min(retryAt - Date.now(), 2_147_483_647),
    );
    return () => clearTimeout(timeout);
  }, [retryAt]);
  if (quota === null) return null;
  const error = failed || quota?.status === "error";
  const cooldown = retryAt !== undefined && retryAt > now;
  const windows = quota?.windows ?? [];
  return (
    <Tooltip
      content={
        <div className="flex flex-col gap-1">
          {windows.map((window, index) => (
            <div key={window.id} className="flex items-baseline gap-2">
              <span className={colors[index % colors.length]}>{windowName(window)}</span>
              <span>{remaining(window)}</span>
              {window.resetsAt !== undefined && (
                <span className="text-neutral-300">{resetTime(window.resetsAt, now)}</span>
              )}
            </div>
          ))}
          {loading && !windows.length && <span>{t("settings:subscriptionQuota.loading")}</span>}
          {error && (
            <span>
              {t(
                quota?.error === "unauthorized"
                  ? "settings:subscriptionQuota.authFailed"
                  : "settings:subscriptionQuota.failed",
              )}
            </span>
          )}
          {error && quota?.readAt !== undefined && (
            <span className="text-neutral-300">
              {t("settings:subscriptionQuota.lastUpdated", {
                time: new Intl.DateTimeFormat(currentFormatLocale(), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(quota.readAt),
              })}
            </span>
          )}
          {!loading && !error && !windows.length && (
            <span>{t("settings:subscriptionQuota.unknown")}</span>
          )}
        </div>
      }
    >
      <Button
        variant="ghost-muted"
        size="icon-sm"
        aria-label={t("settings:subscriptionQuota.label")}
        aria-disabled={loading || cooldown}
        aria-busy={loading}
        onPointerEnter={() => setNow(Date.now())}
        onFocus={() => setNow(Date.now())}
        onClick={() => {
          if (!loading && !cooldown) refresh();
        }}
      >
        <QuotaRing windows={windows} loading={loading} error={error} />
      </Button>
    </Tooltip>
  );
}
