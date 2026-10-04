import type { Usage } from "@earendil-works/pi-ai";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDollarSign,
  Layers3,
  type LucideIcon,
} from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";

const tokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function MessageUsage({ usage }: { usage: Usage }) {
  if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return null;
  return (
    <dl
      aria-label="本次回复用量"
      className="flex select-none flex-wrap items-center gap-x-4 gap-y-1 text-[11px]/4 text-neutral-400 tabular-nums"
    >
      <UsageItem
        icon={ArrowUpFromLine}
        label="输入 token"
        value={tokens.format(usage.input)}
        description={`输入：本次调用发送给模型的非缓存 token，共 ${usage.input.toLocaleString()}。`}
      />
      <UsageItem
        icon={ArrowDownToLine}
        label="输出 token"
        value={tokens.format(usage.output)}
        description={`输出：模型生成的 token，共 ${usage.output.toLocaleString()}${usage.reasoning ? `（含推理 ${usage.reasoning.toLocaleString()}）` : ""}。`}
      />
      {(usage.cacheRead > 0 || usage.cacheWrite > 0) && (
        <UsageItem
          icon={Layers3}
          label="缓存读取 / 写入 token"
          value={`${tokens.format(usage.cacheRead)} / ${tokens.format(usage.cacheWrite)}`}
          description={`缓存读取 / 写入：复用了 ${usage.cacheRead.toLocaleString()} 个缓存 token，新写入 ${usage.cacheWrite.toLocaleString()} 个缓存 token。`}
        />
      )}
      {usage.cost.total > 0 && (
        <UsageItem
          icon={CircleDollarSign}
          label="预估费用"
          value={dollars.format(usage.cost.total)}
          description="费用：本次模型调用的预估金额，以美元计价。"
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
