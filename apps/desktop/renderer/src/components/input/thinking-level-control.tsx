import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ThinkingLevel } from "../../../../src/agent/protocol.ts";
import { thinkingOptions } from "./model-thinking";

export function ThinkingLevelControl({
  level,
  levels,
  disabled,
  onChange,
}: {
  level: ThinkingLevel;
  levels: readonly ThinkingLevel[];
  disabled: boolean;
  onChange: (level: ThinkingLevel) => void;
}) {
  const options = thinkingOptions.filter((option) => levels.includes(option.value));
  const current = Math.max(
    0,
    options.findIndex((option) => option.value === level),
  );
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(current);
  const thumb = useRef<HTMLInputElement>(null);
  if (!options.some((option) => option.value !== "off")) return null;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setPreview(current);
        setOpen(next);
      }}
    >
      <Popover.Trigger
        disabled={disabled || options.length < 2}
        aria-label={`思考级别：${options[current]?.label}`}
        title="调整思考级别"
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-0.5 rounded-full bg-neutral-200/70 px-2 text-[11px] text-neutral-600 outline-none hover:bg-neutral-200 focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:cursor-default"
      >
        {options[current]?.label}
        {open ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            aria-label="调整思考级别"
            initialFocus={thumb}
            className="w-[244px] max-w-[calc(100vw-32px)] rounded-2xl border border-neutral-200 bg-white p-3 shadow-lg outline-none"
          >
            <div className="mb-2.5 flex items-baseline gap-1.5 text-[13px]">
              <span className="text-neutral-500">思考级别</span>
              <span className="font-medium text-neutral-900">{options[preview]?.label}</span>
            </div>
            <div className="mb-1.5 flex justify-between text-[11px] text-neutral-400">
              <span>更快</span>
              <span>更深入</span>
            </div>
            <Slider.Root
              min={0}
              max={options.length - 1}
              step={1}
              largeStep={1}
              value={preview}
              disabled={disabled}
              thumbAlignment="edge"
              onValueChange={setPreview}
              onValueCommitted={(index) => {
                const option = options[index];
                if (option && option.value !== level) onChange(option.value);
              }}
            >
              <Slider.Control className="relative flex h-7 w-full touch-none items-center rounded-lg select-none">
                <Slider.Track className="relative h-full w-full overflow-hidden rounded-lg bg-neutral-100">
                  <Slider.Indicator className="h-full bg-neutral-300" />
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-3 left-3 flex items-center justify-between"
                  >
                    {options.map((option) => (
                      <span
                        key={option.value}
                        className="h-2.5 w-0.5 rounded-full bg-neutral-400/60"
                      />
                    ))}
                  </div>
                </Slider.Track>
                <Slider.Thumb
                  inputRef={thumb}
                  getAriaLabel={() => "思考级别"}
                  getAriaValueText={(_formatted, index) => options[index]?.label ?? ""}
                  className="h-7 w-6 rounded-lg border border-neutral-300 bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
                />
              </Slider.Control>
            </Slider.Root>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
