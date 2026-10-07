import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onValueChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "default" | "compact";
  variant?: "default" | "menu";
  label?: string;
  panelTitle?: string;
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  placeholder,
  disabled,
  size = "default",
  variant = "default",
  label,
  panelTitle,
}: SelectProps<T>) {
  return (
    <BaseSelect.Root
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
    >
      <BaseSelect.Trigger
        aria-label={label}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm text-neutral-800 outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-50",
          size === "compact" && "w-auto rounded-[10px] px-3 py-1 text-[13px]",
          variant === "menu" && "bg-[#f8f8f8] hover:bg-neutral-100",
        )}
      >
        <BaseSelect.Value placeholder={placeholder} className="truncate" />
        <BaseSelect.Icon>
          <ChevronDown size={15} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          sideOffset={5}
          alignItemWithTrigger={false}
          align={variant === "menu" ? "end" : "start"}
          className="z-50 outline-none"
        >
          <BaseSelect.Popup
            className={cn(
              "max-h-[min(360px,var(--available-height))] min-w-(--anchor-width) overflow-y-auto p-1 outline-none",
              variant === "menu"
                ? "min-w-40 rounded-[10px] border border-black/12 bg-[#f8f8f8]/95 text-xs font-normal text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] backdrop-blur-xl select-none"
                : "rounded-xl border border-neutral-200 bg-white shadow-lg",
            )}
          >
            <BaseSelect.Group>
              {panelTitle && (
                <BaseSelect.GroupLabel className="mx-1.5 mb-1 border-b border-black/10 px-0.5 py-1.5 text-xs text-neutral-500">
                  {panelTitle}
                </BaseSelect.GroupLabel>
              )}
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  className={
                    variant === "menu"
                      ? "flex h-[26px] cursor-default items-center gap-1.5 rounded-[5px] px-2 outline-none data-highlighted:bg-[#007aff] data-highlighted:text-white"
                      : "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-neutral-700 outline-none data-highlighted:bg-neutral-100"
                  }
                >
                  <BaseSelect.ItemIndicator
                    keepMounted={variant === "menu"}
                    className={({ selected }) => cn("w-4 shrink-0", !selected && "invisible")}
                  >
                    <Check size={14} />
                  </BaseSelect.ItemIndicator>
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.Group>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
