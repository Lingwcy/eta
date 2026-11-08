import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";

export function Switch(
  props: Omit<ComponentProps<typeof BaseSwitch.Root>, "className" | "children">,
) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className="inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-surface-hover outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus-ring-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface data-[checked]:bg-solid data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 motion-reduce:transition-none"
      {...props}
    >
      <BaseSwitch.Thumb className="size-4 translate-x-0.5 rounded-full bg-white shadow-xs data-[checked]:bg-on-solid transition-transform duration-150 data-[checked]:translate-x-[18px] motion-reduce:transition-none" />
    </BaseSwitch.Root>
  );
}
