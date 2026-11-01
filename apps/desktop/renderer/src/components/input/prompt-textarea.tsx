import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Textarea } from "@/components/ui/textarea";
import type { PromptTextareaProps } from "./types";

export function PromptTextarea({
  value,
  onChange,
  onSubmit,
  allowFollowUp = false,
  placeholder = "Hi, what do you need today?",
  disabled = false,
  minRows = 2,
  className,
}: PromptTextareaProps) {
  useTranslation();
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 拦截非输入法合成状态下的纯 Enter 按键进行提交
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.ctrlKey &&
      (!e.metaKey || allowFollowUp) &&
      !e.altKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      if (!disabled) {
        onSubmit(e.metaKey ? "followUp" : undefined);
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
        aria-label={t("chat:promptTextarea.promptMessageInput")}
      />
    </div>
  );
}
