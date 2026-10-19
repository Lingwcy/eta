import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
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
  useTranslation();
  const percentage = contextWindow
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : 0;
  const showStop = isRunning && (!allowSubmitWhileRunning || !hasContent);
  const actionLabel = showStop
    ? t("chat:actionToolbar.stopGeneration")
    : t("chat:actionToolbar.sendMessage");
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 select-none",
        className,
      )}
      aria-label={t("chat:actionToolbar.messageActions")}
    >
      <div className="flex min-w-0 items-center gap-1">
        {skillsControl}
        {onAttach && (
          <Button
            variant="ghost-muted"
            size="icon-xs"
            onClick={onAttach}
            disabled={disabled || (isRunning && !allowSubmitWhileRunning)}
            aria-label={t("chat:actionToolbar.addImages")}
            title={t("chat:actionToolbar.addImages")}
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
          <span className="hidden min-[701px]:inline-flex">
            <ContextIndicator percentage={percentage} hideText />
          </span>
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
