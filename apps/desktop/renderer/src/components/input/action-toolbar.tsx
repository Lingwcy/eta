import { ArrowUp, Settings2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ContextIndicator } from "./context-indicator";
import type { ActionToolbarProps } from "./types";
import { ModelPicker } from "./model-picker";

export function ActionToolbar({
  model,
  models = [],
  onModelChange,
  thinkingLevel,
  contextTokens = 0,
  contextWindow,
  onSubmit,
  onStop,
  onSettings,
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
      className={cn("flex items-center justify-between gap-2 select-none", className)}
      aria-label="消息操作栏"
    >
      <Button
        type="button"
        variant="accent"
        size="compact"
        onClick={onSettings}
        disabled={!onSettings}
        title="模型与认证设置"
        aria-label="模型与认证设置"
      >
        <Settings2 size={18} aria-hidden="true" />
        <span className="hidden min-[701px]:inline">配置</span>
      </Button>
      <div className="flex min-w-0 items-center gap-2.5">
        <ModelPicker
          model={model}
          models={models}
          thinkingLevel={thinkingLevel}
          disabled={disabled || isRunning}
          onChange={onModelChange}
          onSettings={onSettings}
        />
        {contextWindow && contextTokens > 0 && (
          <ContextIndicator percentage={percentage} hideText />
        )}
        {isRunning ? (
          <Button
            type="button"
            disabled={!onStop || isStopping}
            onClick={onStop}
            variant="default"
            size="icon-round"
            aria-label="停止生成"
            title="停止生成"
          >
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </Button>
        ) : (
          <Button
            type="button"
            disabled={disabled || !canSubmit}
            onClick={onSubmit}
            variant="default"
            size="icon-round"
            aria-label="发送消息"
            title="发送消息"
          >
            <ArrowUp size={20} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
      </div>
    </footer>
  );
}
