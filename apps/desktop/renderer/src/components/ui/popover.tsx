import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps } from "react";

export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;

export function PopoverContent(props: Omit<ComponentProps<typeof BasePopover.Popup>, "className">) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner side="top" align="start" sideOffset={8} className="z-30">
        <BasePopover.Popup
          className="flex max-h-[min(420px,var(--available-height))] w-[300px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl outline-none transition-[opacity,transform] duration-150 data-starting-style:translate-y-1 data-starting-style:opacity-0 data-ending-style:translate-y-1 data-ending-style:opacity-0 motion-reduce:transition-none"
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
