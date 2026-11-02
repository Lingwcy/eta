import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useState } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Check, Eye, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sandboxModes } from "@eta/core/shared/sandbox";
import type { SandboxMode } from "@eta/core/shared/sandbox";

const options = () => ({
  "read-only": {
    icon: Eye,
    description: t("chat:sandboxPicker.inspectWorkspaceFilesEditsAndExecutionRequire"),
  },
  "workspace-write": {
    icon: ShieldCheck,
    description: t("chat:sandboxPicker.readWriteRunCommandsAndAccessThe"),
  },
  "danger-full-access": {
    icon: ShieldAlert,
    description: t("chat:sandboxPicker.accessFilesOnThisComputerAndThe"),
  },
});

export function SandboxPicker({
  mode,
  defaultMode = "workspace-write",
  allowedModes = sandboxModes,
  disabled = false,
  disabledReason,
  side = "top",
  responsive = false,
  onChange,
}: {
  mode: SandboxMode;
  defaultMode?: SandboxMode;
  allowedModes?: readonly SandboxMode[];
  disabled?: boolean;
  disabledReason?: string;
  side?: "top" | "bottom";
  responsive?: boolean;
  onChange?: (mode: SandboxMode) => void;
}) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = options()[mode].icon;
  const label = allowedModes.length
    ? t(`chat:sandbox.${mode}`)
    : t("chat:sandboxPicker.sandboxUnavailable");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={mode === "danger-full-access" ? "accent" : "ghost"}
            size="pill"
            selected={open}
          />
        }
        disabled={!onChange}
        aria-label={t("chat:sandboxPicker.sandboxPolicy", { label: label })}
        title={
          disabled
            ? (disabledReason ?? t("chat:sandboxPicker.thePolicyCannotBeChangedRightNow"))
            : options()[mode].description
        }
      >
        <Icon size={16} aria-hidden="true" />
        <span
          className={cn(
            "truncate",
            responsive
              ? "hidden max-w-28 @min-[640px]/composer:inline"
              : "max-w-14 min-[701px]:max-w-none",
          )}
        >
          {label}
        </span>
      </PopoverTrigger>
      <PopoverContent
        variant="menu"
        size="wide"
        side={side}
        aria-label={t("chat:sandboxPicker.sandboxPolicy2")}
      >
        <p className="px-2 py-1.5 text-[11px] text-neutral-500">
          {t("chat:sandboxPicker.whatCanTheAgentAccess")}
        </p>
        {disabled && (
          <p role="status" className="px-2 pb-1.5 text-[11px] leading-4 text-neutral-500">
            {disabledReason ?? t("chat:sandboxPicker.thePolicyCannotBeChangedRightNow")}
          </p>
        )}
        <div className="mx-1.5 mb-1 h-px shrink-0 bg-black/10" />
        {sandboxModes.map((value) => {
          const ItemIcon = options()[value].icon;
          const allowed = allowedModes.includes(value);
          return (
            <BaseButton
              key={value}
              disabled={disabled || !allowed}
              aria-pressed={mode === value}
              onClick={() => {
                onChange?.(value);
                setOpen(false);
              }}
              className={`group flex w-full cursor-default items-center gap-1.5 rounded-[5px] px-2 py-1.5 text-left outline-none select-none enabled:hover:bg-[#007aff] enabled:hover:text-white enabled:focus-visible:bg-[#007aff] enabled:focus-visible:text-white disabled:opacity-35 ${value === "danger-full-access" ? "text-orange-600" : "text-neutral-800"}`}
            >
              <ItemIcon size={14} strokeWidth={1.7} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs leading-4">
                  {t(`chat:sandbox.${value}`)}
                  {value === defaultMode ? t("chat:sandboxPicker.default") : ""}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 opacity-65 group-hover:opacity-90 group-focus-visible:opacity-90">
                  {allowed
                    ? options()[value].description
                    : t("chat:sandboxPicker.thisEnvironmentDoesNotOfferThisPolicy")}
                </span>
              </span>
              <span className="flex w-3.5 shrink-0 items-center justify-center">
                {allowed && mode === value && (
                  <Check size={14} strokeWidth={1.7} aria-hidden="true" />
                )}
              </span>
            </BaseButton>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
