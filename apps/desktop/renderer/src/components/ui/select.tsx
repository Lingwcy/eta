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
  label?: string;
}

export function Select<T extends string>({
  value,
  options,
  onValueChange,
  placeholder,
  disabled,
  size = "default",
  label,
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
          className="z-50 outline-none"
        >
          <BaseSelect.Popup className="max-h-[min(360px,var(--available-height))] min-w-(--anchor-width) overflow-y-auto rounded-xl border border-neutral-200 bg-white p-1 shadow-lg outline-none">
            {options.map((option) => (
              <BaseSelect.Item
                key={option.value}
                value={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-neutral-700 outline-none data-highlighted:bg-neutral-100"
              >
                <BaseSelect.ItemIndicator className="w-4">
                  <Check size={14} />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}
