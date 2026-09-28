import { ArrowUp, ChevronDown, Gauge, Mic, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextIndicator } from "./context-indicator";
import type { ActionToolbarProps, ExecutionMode } from "./types";

const NEXT_MODE: Record<ExecutionMode, ExecutionMode> = {
  auto: "speed",
  speed: "quality",
  quality: "auto",
};

const MODE_LABELS: Record<ExecutionMode, string> = {
  auto: "Auto",
  speed: "Speed",
  quality: "Quality",
};

/**
 * 底部操作工具栏组件：
 */
export function ActionToolbar({
  modelName = "GPT-5.6 Mini",
  reasoningLevel,
  onModelClick,
  tokenPercentage = 57,
  hideContextText = false,
  onContextClick,
  executionMode,
  onExecutionModeChange,
  isListening,
  onToggleListening,
  onPlusClick,
  onSubmit,
  canSubmit,
  isSubmitting = false,
  className,
}: ActionToolbarProps) {
  const handleToggleMode = () => {
    onExecutionModeChange(NEXT_MODE[executionMode]);
  };

  return (
    <footer
      className={cn("flex items-center justify-between gap-2 pt-1 select-none", className)}
      aria-label="Prompt 动作操作栏"
    >
      {/* 左侧操作区域：附件与执行模式 */}
      <div className="flex items-center gap-1 sm:gap-2">
        {/* 加号 / 添加上下文附件按钮 */}
        <button
          type="button"
          onClick={onPlusClick}
          className="size-9 rounded-full bg-neutral-100 hover:bg-neutral-200/80 active:scale-95 text-neutral-800 flex items-center justify-center transition-colors cursor-pointer"
          aria-label="添加附件或上下文"
          title="添加附件或上下文"
        >
          <Plus className="size-4.5 stroke-[2.2]" />
        </button>

        {/* 执行模式切换按钮 */}
        <button
          type="button"
          onClick={handleToggleMode}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full hover:bg-neutral-100 text-neutral-700 font-medium text-sm transition-colors cursor-pointer group"
          title={`执行模式: ${MODE_LABELS[executionMode]}（点击切换）`}
          aria-label={`当前执行模式: ${MODE_LABELS[executionMode]}`}
        >
          <Gauge className="size-4 text-neutral-600 group-hover:text-neutral-900 transition-colors shrink-0" />
          <span>{MODE_LABELS[executionMode]}</span>
        </button>
      </div>

      {/* 右侧操作区域：上下文窗口、模型选择器、语音与发送 */}
      <div className="flex items-center gap-1 sm:gap-1.5">
        {/* 上下文窗口用量指示器（位于模型选择器正左侧） */}
        <ContextIndicator
          percentage={tokenPercentage}
          hideText={hideContextText}
          onClick={onContextClick}
        />

        {/* 模型触发器按钮 */}
        <button
          type="button"
          onClick={onModelClick}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-neutral-100 text-neutral-700 hover:text-neutral-900 text-sm font-medium transition-colors cursor-pointer select-none"
          aria-label={`当前模型: ${modelName}${reasoningLevel ? ` (${reasoningLevel})` : ""}`}
          title={`当前模型: ${modelName}`}
        >
          <span className="truncate max-w-[130px] sm:max-w-[160px]">{modelName}</span>
          {reasoningLevel && (
            <span className="text-neutral-400 text-xs font-normal">{reasoningLevel}</span>
          )}
          <ChevronDown className="size-4 text-neutral-500 shrink-0" />
        </button>

        {/* 语音输入麦克风按钮 */}
        <button
          type="button"
          onClick={onToggleListening}
          className={cn(
            "size-9 rounded-full border transition-all flex items-center justify-center cursor-pointer",
            isListening
              ? "border-red-500 bg-red-50 text-red-600 ring-2 ring-red-400/20 animate-pulse"
              : "border-neutral-200 bg-white hover:bg-neutral-50 hover:border-neutral-300 text-neutral-800",
          )}
          aria-label={isListening ? "停止语音输入" : "开启语音输入"}
          title={isListening ? "正在聆听中...（点击停止）" : "语音输入"}
        >
          <Mic className="size-4.5 shrink-0" />
        </button>

        {/* 发送 / 提交消息按钮 */}
        <button
          type="button"
          disabled={!canSubmit || isSubmitting}
          onClick={onSubmit}
          className="size-9 rounded-full bg-[#E52222] hover:bg-[#d41c1c] active:scale-95 text-white flex items-center justify-center shadow-xs transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 shrink-0"
          aria-label="发送消息"
          title="发送消息"
        >
          <ArrowUp className="size-4.5 stroke-[2.5]" />
        </button>
      </div>
    </footer>
  );
}
