import { cn } from "@/lib/utils";
import type { ContextIndicatorProps } from "./types";

/**
 * 上下文窗口用量指示器组件：
 * 采用环形 SVG 进度圈配合百分比数值展示 Token 消耗量，放置在模型选择器的左侧。
 */
export function ContextIndicator({
  percentage = 0,
  hideText = false,
  className,
  onClick,
}: ContextIndicatorProps) {
  // 将百分比严格限制在 0 至 100 之间
  const clampedPercentage = Math.min(100, Math.max(0, percentage));
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clampedPercentage / 100) * circumference;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 text-neutral-500 hover:text-neutral-800 text-xs sm:text-sm font-medium px-2 py-1.5 rounded-xl hover:bg-neutral-100 select-none transition-colors cursor-pointer",
        className,
      )}
      title={`上下文窗口用量: ${clampedPercentage}%`}
      aria-label={`上下文窗口用量: ${clampedPercentage}%`}
    >
      <svg
        className="size-3.5 sm:size-4 -rotate-90 text-neutral-600 shrink-0"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-neutral-300"
        />
        <circle
          cx="8"
          cy="8"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
        />
      </svg>
      {!hideText && <span className="tabular-nums font-medium">{clampedPercentage}%</span>}
    </button>
  );
}
