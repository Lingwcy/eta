import { useState } from "react";
import { cn } from "@/lib/utils";
import { ActionToolbar } from "./action-toolbar";
import { PromptTextarea } from "./prompt-textarea";
import type { CompositeInputProps, ExecutionMode } from "./types";

/**
 * 复合 AI Prompt 输入组件
 */
export function CompositeInput({
  defaultValue = "",
  placeholder = "Hi, what do you need today?",
  tokenPercentage = 57,
  modelName = "未选择模型",
  reasoningLevel,
  executionMode,
  isListening: controlledListening,
  onToggleListening: controlledOnToggleListening,
  hideContextText = false,
  disabled = false,
  isSubmitting = false,
  onContextClick,
  onModelClick,
  onPlusClick,
  onChange,
  onSubmit,
  className,
}: CompositeInputProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const textValue = internalValue;
  const setTextValue = (val: string) => {
    setInternalValue(val);
    onChange?.(val);
  };

  // 执行模式状态维护
  const [internalMode, setInternalMode] = useState<ExecutionMode>("auto");
  const mode = executionMode !== undefined ? executionMode : internalMode;
  const setMode = (newMode: ExecutionMode) => {
    if (executionMode === undefined) {
      setInternalMode(newMode);
    }
  };

  // 语音输入状态维护
  const [internalListening, setInternalListening] = useState(false);
  const isListening = controlledListening !== undefined ? controlledListening : internalListening;
  const toggleListening = () => {
    if (controlledListening === undefined) {
      setInternalListening((prev) => !prev);
    }
    controlledOnToggleListening?.();
  };

  // 消息提交处理
  const handleSubmit = () => {
    const trimmed = textValue.trim();
    if (!trimmed || disabled || isSubmitting) return;

    onSubmit?.(trimmed, {
      model: modelName,
      mode,
      reasoningLevel,
    });
    setInternalValue("");
  };

  const canSubmit = textValue.trim().length > 0;

  return (
    <div
      className={cn(
        "w-full max-w-2xl mx-auto bg-white rounded-[26px] sm:rounded-[28px] border border-neutral-200/80 shadow-md shadow-black/5 p-4 sm:px-5 sm:pt-4 sm:pb-3.5 flex flex-col gap-3 transition-shadow focus-within:border-neutral-300 focus-within:shadow-lg focus-within:shadow-black/10 select-none",
        className,
      )}
    >
      {/* 自适应多行 Prompt 输入框 */}
      <PromptTextarea
        value={textValue}
        onChange={setTextValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        disabled={disabled}
      />

      {/* 底部操作工具栏 */}
      <ActionToolbar
        modelName={modelName}
        reasoningLevel={reasoningLevel}
        onModelClick={onModelClick}
        tokenPercentage={tokenPercentage}
        hideContextText={hideContextText}
        onContextClick={onContextClick}
        executionMode={mode}
        onExecutionModeChange={setMode}
        isListening={isListening}
        onToggleListening={toggleListening}
        onPlusClick={onPlusClick}
        onSubmit={handleSubmit}
        canSubmit={canSubmit}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}
