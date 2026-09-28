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
    if (!text.trim() || disabled || isRunning || submitting || !onSubmit) return;
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
        "mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-[26px] border border-neutral-200/80 bg-white p-4 shadow-md shadow-black/5 transition-shadow focus-within:border-neutral-300 focus-within:shadow-lg focus-within:shadow-black/10 sm:rounded-[28px] sm:px-5 sm:pt-4 sm:pb-3.5",
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
        canSubmit={Boolean(onSubmit) && Boolean(text.trim())}
      />
    </div>
  );
}
