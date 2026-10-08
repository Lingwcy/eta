import { ArrowUp, Square, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ContextIndicator } from "./context-indicator";
import type { ActionToolbarProps } from "./types";
import { ModelPicker } from "./model-picker";

export function ActionToolbar({
  skillsControl,
  inputMode = "steer",
  onInputModeChange,
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
      <div className="flex items-center gap-1">
        {skillsControl}
        {onAttach && (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            onClick={onAttach}
            disabled={disabled}
            aria-label="添加图片"
            title="添加图片"
          >
            <Paperclip size={17} aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2.5">
        {isRunning && onInputModeChange && (
          <Select
            value={inputMode}
            onValueChange={onInputModeChange}
            options={[
              { value: "steer", label: "引导输入" },
              { value: "followUp", label: "后续输入" },
            ]}
            label="运行中消息的加入时机"
            size="compact"
            variant="menu"
            disabled={disabled || isStopping}
          />
        )}
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
        ) : null}
        {(!isRunning || canSubmit) && (
          <Button
            type="button"
            disabled={disabled || !canSubmit}
            onClick={onSubmit}
            variant="default"
            size="icon-round"
            aria-label={
              isRunning ? (inputMode === "steer" ? "发送引导输入" : "发送后续输入") : "发送消息"
            }
            title={
              isRunning
                ? inputMode === "steer"
                  ? "当前工具轮次结束后加入"
                  : "本次回答后启动下一次运行"
                : "发送消息"
            }
          >
            <ArrowUp size={20} strokeWidth={2} aria-hidden="true" />
          </Button>
        )}
      </div>
    </footer>
  );
}
