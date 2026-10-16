import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";

export function SegmentedControl<Value extends string>({
  value,
  options,
  disabled,
  onValueChange,
  "aria-label": label,
}: {
  value: Value;
  options: readonly { value: Value; label: ReactNode }[];
  disabled?: boolean;
  onValueChange: (value: Value) => void;
  "aria-label": string;
}) {
  const selectedIndex = options.findIndex((option) => option.value === value);
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
      className="relative inline-grid shrink-0 rounded-lg bg-neutral-100 p-1 data-[disabled]:opacity-40"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {selectedIndex >= 0 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 left-1 rounded-md bg-white shadow-xs transition-transform duration-150 motion-reduce:transition-none"
          style={{
            width: `calc((100% - 0.5rem) / ${options.length})`,
            transform: `translateX(${selectedIndex * 100}%)`,
          }}
        />
      )}
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          className="relative flex h-7 cursor-pointer items-center justify-center rounded-md px-2.5 text-xs font-medium whitespace-nowrap text-neutral-500 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-neutral-400 data-[checked]:text-neutral-900 data-[disabled]:cursor-not-allowed motion-reduce:transition-none"
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
