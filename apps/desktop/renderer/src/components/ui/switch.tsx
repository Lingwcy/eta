import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";

export function Switch(
  props: Omit<ComponentProps<typeof BaseSwitch.Root>, "className" | "children">,
) {
  return (
    <BaseSwitch.Root
      data-slot="switch"
      className="group/switch inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-surface-hover outline-none transition-colors duration-(--eta-duration-normal) ease-(--eta-ease-out) focus-visible:ring-2 focus-visible:ring-focus-ring-400 focus-visible:ring-offset-2 focus-visible:ring-offset-surface data-[checked]:bg-solid data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40"
      {...props}
    >
      <BaseSwitch.Thumb className="size-4 origin-left translate-x-0.5 rounded-full bg-white shadow-xs motion-safe:transition-transform motion-safe:duration-(--eta-duration-normal) motion-safe:ease-(--eta-ease-out) motion-safe:group-active/switch:group-not-data-[disabled]/switch:scale-x-110 data-[checked]:origin-right data-[checked]:translate-x-[18px] data-[checked]:bg-on-solid" />
    </BaseSwitch.Root>
  );
}
