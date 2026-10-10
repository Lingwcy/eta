import { ArrowUp, Square, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ContextIndicator } from "./context-indicator";
import type { ActionToolbarProps } from "./types";
import { ModelPicker } from "./model-picker";
import { SandboxPicker } from "./sandbox-picker";

export function ActionToolbar({
  skillsControl,
  sandboxMode,
  allowedSandboxModes,
  sandboxDisabled,
  sandboxDisabledReason,
  onSandboxChange,
  model,
  models = [],
  providers = [],
  onModelChange,
  thinkingLevel,
  contextTokens = 0,
  contextWindow,
  onSubmit,
  onStop,
  onSettings,
  onAttach,
  canSubmit,
  hasContent = canSubmit,
  isRunning = false,
  allowSubmitWhileRunning = false,
  isStopping = false,
  disabled = false,
  className,
}: ActionToolbarProps) {
  const percentage = contextWindow
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : 0;
  const showStop = isRunning && (!allowSubmitWhileRunning || !hasContent);
  const actionLabel = showStop ? "停止生成" : "发送消息";
  return (
    <footer
      className={cn("flex items-center justify-between gap-2 select-none", className)}
      aria-label="消息操作栏"
    >
      <div className="flex items-center gap-1">
        {skillsControl}
        {onAttach && (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            onClick={onAttach}
            disabled={disabled || (isRunning && !allowSubmitWhileRunning)}
            aria-label="添加图片"
            title="添加图片"
          >
            <Paperclip size={17} aria-hidden="true" />
          </Button>
        )}
        {sandboxMode && (
          <SandboxPicker
            mode={sandboxMode}
            allowedModes={allowedSandboxModes}
            disabled={sandboxDisabled ?? (disabled || isRunning)}
            disabledReason={sandboxDisabledReason}
            onChange={onSandboxChange}
          />
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2.5">
        <ModelPicker
          model={model}
          models={models}
          providers={providers}
          thinkingLevel={thinkingLevel}
          disabled={disabled || isRunning}
          onChange={onModelChange}
          onSettings={onSettings}
        />
        {contextWindow && contextTokens > 0 && (
          <ContextIndicator percentage={percentage} hideText />
        )}
        <Button
          type="button"
          disabled={showStop ? !onStop || isStopping : disabled || !canSubmit || isStopping}
          onClick={showStop ? onStop : onSubmit}
          variant="default"
          size="icon-round"
          aria-label={actionLabel}
          title={actionLabel}
        >
          {showStop ? (
            <Square size={14} fill="currentColor" aria-hidden="true" />
          ) : (
            <ArrowUp size={20} strokeWidth={2} aria-hidden="true" />
          )}
        </Button>
      </div>
    </footer>
  );
}
