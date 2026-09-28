import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { PromptTextareaProps } from "./types";

/**
 * 自动伸缩的多行 Prompt 输入框组件：
 */
export function PromptTextarea({
  value,
  onChange,
  onSubmit,
  placeholder = "Hi, what do you need today?",
  disabled = false,
  minRows = 2,
  className,
}: PromptTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 根据文字内容高度自适应调整高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const newHeight = Math.max(el.scrollHeight, minRows * 24);
    el.style.height = `${newHeight}px`;
  }, [value, minRows]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 拦截非输入法合成状态下的纯 Enter 按键进行提交
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSubmit();
      }
    }
  };

  return (
    <div className="w-full">
      <textarea
        ref={textareaRef}
        rows={minRows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          "w-full resize-none border-0 bg-transparent p-0 text-base sm:text-[15px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-0 disabled:opacity-50 disabled:cursor-not-allowed",
          className,
        )}
        aria-label="Prompt 消息输入框"
      />
    </div>
  );
}
