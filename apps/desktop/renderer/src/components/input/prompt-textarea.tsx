import { Textarea } from "@/components/ui/textarea";
import type { PromptTextareaProps } from "./types";

export function PromptTextarea({
  value,
  onChange,
  onSubmit,
  placeholder = "Hi, what do you need today?",
  disabled = false,
  minRows = 2,
  className,
}: PromptTextareaProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 拦截非输入法合成状态下的纯 Enter 按键进行提交
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!disabled) {
        onSubmit();
      }
    }
  };

  return (
    <div className="w-full">
      <Textarea
        rows={minRows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
        aria-label="Prompt 消息输入框"
      />
    </div>
  );
}
