import { useTranslation } from "react-i18next";
import { t, currentFormatLocale } from "@/i18n";
import type { Usage } from "@earendil-works/pi-ai";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDollarSign,
  Layers3,
  type LucideIcon,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

const tokens = () =>
  new Intl.NumberFormat(currentFormatLocale(), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
const dollars = () =>
  new Intl.NumberFormat(currentFormatLocale(), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });

export function MessageUsage({ usage }: { usage: Usage }) {
  useTranslation();
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return null;
  return (
    <dl
      aria-label={t("chat:messageUsage.usageForThisResponse")}
      className="flex select-none flex-wrap items-center gap-x-4 gap-y-1 text-[11px]/4 text-neutral-500 tabular-nums"
    >
      <UsageItem
        icon={ArrowUpFromLine}
        label={t("chat:messageUsage.inputTokens")}
        value={tokens().format(usage.input)}
        description={t("chat:messageUsage.inputNonCachedTokensSentToThe", {
          value1: usage.input.toLocaleString(currentFormatLocale()),
        })}
      />
      <UsageItem
        icon={ArrowDownToLine}
        label={t("chat:messageUsage.outputTokens")}
        value={tokens().format(usage.output)}
        description={t("chat:messageUsage.outputTokensGeneratedByTheModel", {
          value1: usage.output.toLocaleString(currentFormatLocale()),
          value2: usage.reasoning
            ? t("chat:messageUsage.reasoning", {
                tokens: usage.reasoning.toLocaleString(currentFormatLocale()),
              })
            : "",
        })}
      />
      {(usage.cacheRead > 0 || usage.cacheWrite > 0) && (
        <UsageItem
          icon={Layers3}
          label={t("chat:messageUsage.cacheReadWriteTokens")}
          value={`${tokens().format(usage.cacheRead)} / ${tokens().format(usage.cacheWrite)}`}
          description={t("chat:messageUsage.cacheCachedTokensReusedAndNewTokens", {
            value1: usage.cacheRead.toLocaleString(currentFormatLocale()),
            value2: usage.cacheWrite.toLocaleString(currentFormatLocale()),
          })}
        />
      )}
      {usage.cost.total > 0 && (
        <UsageItem
          icon={CircleDollarSign}
          label={t("chat:messageUsage.estimatedCost")}
          value={dollars().format(usage.cost.total)}
          description={t("chat:messageUsage.costTheEstimatedPriceOfThisModel")}
        />
      )}
    </dl>
  );
}

function UsageItem({
  icon: Icon,
  label,
  value,
  description,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Tooltip content={<span className="block max-w-xs select-none leading-5">{description}</span>}>
      <div
        tabIndex={0}
        className="flex cursor-default items-center gap-1.5 rounded-sm outline-none hover:text-neutral-600 focus-visible:ring-2 focus-visible:ring-neutral-300"
      >
        <dt>
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">{label}</span>
        </dt>
        <dd>{value}</dd>
      </div>
    </Tooltip>
  );
}
