import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

export function PopoverContent({
  variant = "default",
  size = "default",
  side = "top",
  ...props
}: Omit<ComponentProps<typeof BasePopover.Popup>, "className"> & {
  variant?: "default" | "menu";
  size?: "default" | "wide";
  side?: "top" | "bottom";
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} align="start" sideOffset={8} className="z-30">
        <BasePopover.Popup
          className={cn(
            "flex max-h-[min(420px,var(--available-height))] max-w-[calc(100vw-32px)] flex-col overflow-hidden border outline-none transition-[opacity,transform] duration-150 data-starting-style:translate-y-1 data-starting-style:opacity-0 data-ending-style:translate-y-1 data-ending-style:opacity-0 motion-reduce:transition-none",
            variant === "menu"
              ? "rounded-[10px] border-black/12 bg-[#f8f8f8]/95 p-1 text-xs font-normal text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] backdrop-blur-xl"
              : "rounded-2xl border-neutral-200 bg-white shadow-xl",
            size === "wide" ? "w-80" : variant === "menu" ? "w-56" : "w-[300px]",
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
