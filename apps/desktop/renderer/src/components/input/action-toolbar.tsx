import { ArrowUp, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextIndicator } from "./context-indicator";
import type { ActionToolbarProps } from "./types";

export function ActionToolbar({
  model,
  thinkingLevel,
  contextTokens = 0,
  contextWindow,
  onSubmit,
  onStop,
  canSubmit,
  isRunning = false,
  isStopping = false,
  disabled = false,
  className,
}: ActionToolbarProps) {
  const percentage = contextWindow
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : 0;
  return (
    <footer
      className={cn("flex items-center justify-between gap-2 pt-1 select-none", className)}
      aria-label="Prompt 动作操作栏"
    >
      <div
        className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-neutral-700"
        title={model ? `${model.provider}/${model.id}` : undefined}
      >
        <span className="truncate">{model?.name ?? "模型准备中"}</span>
        {thinkingLevel && thinkingLevel !== "off" && (
          <span className="text-xs font-normal text-neutral-400">{thinkingLevel}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {contextWindow && <ContextIndicator percentage={percentage} />}
        {isRunning ? (
          <button
            type="button"
            disabled={!onStop || isStopping}
            onClick={onStop}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-neutral-900 text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="停止生成"
            title="停止生成"
          >
            <Square className="size-3.5" fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            disabled={disabled || !canSubmit}
            onClick={onSubmit}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-[#E52222] text-white shadow-xs transition-colors hover:bg-[#d41c1c] disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="发送消息"
            title="发送消息"
          >
            <ArrowUp className="size-4.5 stroke-[2.5]" aria-hidden="true" />
          </button>
        )}
      </div>
    </footer>
  );
}
