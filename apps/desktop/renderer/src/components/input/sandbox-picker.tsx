import { useState } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Check, Eye, ShieldCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { sandboxLabels, sandboxModes } from "@eta/core/shared/sandbox";
import type { SandboxMode } from "@eta/core/shared/sandbox";

const options = {
  "read-only": { icon: Eye, description: "检查工作区文件；编辑和执行需批准。" },
  "workspace-write": {
    icon: ShieldCheck,
    description: "工作区内读写、执行和联网；越界访问需批准。",
  },
  "danger-full-access": {
    icon: ShieldAlert,
    description: "可访问电脑上的文件和互联网，无沙盒边界。",
  },
};

export function SandboxPicker({
  mode,
  allowedModes = sandboxModes,
  disabled = false,
  disabledReason,
  side = "top",
  onChange,
}: {
  mode: SandboxMode;
  allowedModes?: readonly SandboxMode[];
  disabled?: boolean;
  disabledReason?: string;
  side?: "top" | "bottom";
  onChange?: (mode: SandboxMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = options[mode].icon;
  const label = allowedModes.length ? sandboxLabels[mode] : "沙盒不可用";
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
        aria-label={`沙盒策略：${label}`}
        title={disabled ? (disabledReason ?? "当前暂时无法切换策略") : options[mode].description}
      >
        <Icon size={16} aria-hidden="true" /> {label}
      </PopoverTrigger>
      <PopoverContent variant="menu" size="wide" side={side} aria-label="沙盒策略">
        <p className="px-2 py-1.5 text-[11px] text-neutral-500">代理可以访问哪些内容？</p>
        {disabled && (
          <p role="status" className="px-2 pb-1.5 text-[11px] leading-4 text-neutral-500">
            {disabledReason ?? "当前暂时无法切换策略"}
          </p>
        )}
        <div className="mx-1.5 mb-1 h-px shrink-0 bg-black/10" />
        {sandboxModes.map((value) => {
          const ItemIcon = options[value].icon;
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
                  {sandboxLabels[value]}
                  {value === "workspace-write" ? "（默认）" : ""}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 opacity-65 group-hover:opacity-90 group-focus-visible:opacity-90">
                  {allowed ? options[value].description : "当前执行环境未开放此策略"}
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
