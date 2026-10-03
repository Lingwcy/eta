import { useState } from "react";
import { cn } from "@/lib/utils";
import { ActionToolbar } from "./action-toolbar";
import { PromptTextarea } from "./prompt-textarea";
import type { CompositeInputProps } from "./types";

export function CompositeInput({
  value,
  defaultValue = "",
  onChange,
  onSubmit,
  placeholder = "Hi, what do you need today?",
  disabled = false,
  submitDisabled = false,
  isRunning = false,
  className,
  ...toolbar
}: CompositeInputProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [submitting, setSubmitting] = useState(false);
  const text = value ?? internalValue;
  const setText = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onChange?.(next);
  };
  const handleSubmit = async () => {
    if (!text.trim() || disabled || submitDisabled || isRunning || submitting || !onSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(text.trim());
      setText("");
    } catch {
      /* The harness client reports the failure; preserve the draft for retry. */
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div
      className={cn(
        "relative flex w-full flex-col gap-5 rounded-[20px] border border-neutral-200/80 bg-white p-3 shadow-[0_2px_6px_#00000003,0_9px_35px_#00000004] focus-within:border-neutral-300 min-[701px]:rounded-[24px] min-[701px]:px-4 min-[701px]:pt-4 min-[701px]:pb-3",
        className,
      )}
    >
      <PromptTextarea
        value={text}
        onChange={setText}
        onSubmit={() => {
          void handleSubmit();
        }}
        placeholder={placeholder}
        disabled={disabled || submitting || isRunning}
      />
      <ActionToolbar
        {...toolbar}
        disabled={disabled || submitting}
        isRunning={isRunning}
        onSubmit={() => {
          void handleSubmit();
        }}
        canSubmit={!submitDisabled && Boolean(onSubmit) && Boolean(text.trim())}
      />
    </div>
  );
}
