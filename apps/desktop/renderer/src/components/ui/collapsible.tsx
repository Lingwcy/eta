import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonProps } from "./button";

export const Collapsible = BaseCollapsible.Root;

type TriggerProps = Omit<ComponentProps<typeof BaseCollapsible.Trigger>, "render" | "className"> &
  Pick<ButtonProps, "variant" | "size" | "selected" | "indent">;

export function CollapsibleTrigger({
  variant = "ghost",
  size = "row",
  selected,
  indent,
  ...props
}: TriggerProps) {
  return (
    <BaseCollapsible.Trigger
      render={<Button variant={variant} size={size} selected={selected} indent={indent} />}
      {...props}
    />
  );
}

export function CollapsibleContent({
  className,
  ...props
}: Omit<ComponentProps<typeof BaseCollapsible.Panel>, "className"> & { className?: string }) {
  return (
    <BaseCollapsible.Panel
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}
