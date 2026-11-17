import { useEffect, useRef, useState } from "react";
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
  defaultSandboxMode,
  allowedSandboxModes,
  sandboxDisabled,
  sandboxDisabledReason,
  onSandboxChange,
  model,
  models = [],
  recentModels,
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
  const [sendPulse, setSendPulse] = useState(false);
  const pulseTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pulseTimer.current), []);
  const percentage = contextWindow
    ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
    : 0;
  const showStop = isRunning && (!allowSubmitWhileRunning || !hasContent);
  const actionLabel = showStop
    ? t("chat:actionToolbar.stopGeneration")
    : t("chat:actionToolbar.sendMessage");
  const handlePrimaryClick = () => {
    if (showStop) {
      onStop?.();
      return;
    }
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setSendPulse(true);
      window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setSendPulse(false), 160);
    }
    onSubmit?.();
  };
  return (
    <footer
      className={cn("flex items-center justify-between gap-2 select-none", className)}
      aria-label={t("chat:actionToolbar.messageActions")}
    >
      <div className="flex shrink-0 items-center gap-1">
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
            responsive
            mode={sandboxMode}
            defaultMode={defaultSandboxMode}
            allowedModes={allowedSandboxModes}
            disabled={sandboxDisabled ?? (disabled || isRunning)}
            disabledReason={sandboxDisabledReason}
            onChange={onSandboxChange}
          />
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        <div className="hidden @min-[300px]/composer:contents">
          <ModelPicker
            responsive
            model={model}
            models={models}
            recentModels={recentModels}
            providers={providers}
            thinkingLevel={thinkingLevel}
            disabled={disabled || isRunning}
            onChange={onModelChange}
            onSettings={onSettings}
          />
        </div>
        {contextWindow && contextTokens > 0 && (
          <span className="hidden @min-[300px]/composer:inline-flex">
            <ContextIndicator percentage={percentage} hideText />
          </span>
        )}
        <Button
          type="button"
          disabled={showStop ? !onStop || isStopping : disabled || !canSubmit || isStopping}
          onClick={handlePrimaryClick}
          variant="default"
          size="icon-round"
          aria-label={actionLabel}
          title={actionLabel}
        >
          {showStop ? (
            <Square
              size={14}
              fill="currentColor"
              aria-hidden="true"
              className="motion-safe:transition-transform duration-(--eta-duration-fast) ease-(--eta-ease-out) motion-safe:starting:scale-75"
            />
          ) : (
            <ArrowUp
              size={20}
              strokeWidth={2}
              aria-hidden="true"
              className={cn(
                "motion-safe:transition-transform duration-(--eta-duration-fast) ease-(--eta-ease-out) motion-safe:starting:scale-75",
                sendPulse &&
                  "motion-safe:animate-[eta-send-nudge_var(--eta-duration-normal)_var(--eta-ease-out)]",
              )}
            />
          )}
        </Button>
      </div>
    </footer>
  );
}
