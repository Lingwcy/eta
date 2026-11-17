import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = BaseTabs.Root;

type TabsVariant = "default" | "inspector" | "sidebar";

export function TabsList({
  variant = "default",
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof BaseTabs.List>, "className"> & {
  variant?: TabsVariant;
  className?: string;
}) {
  return (
    <BaseTabs.List className={cn("relative", className)} {...props}>
      {(variant === "sidebar" || variant === "inspector") && (
        <BaseTabs.Indicator
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) translate-y-(--active-tab-top) bg-surface-hover/70 transition-[translate,width,height] duration-(--eta-duration-normal) ease-(--eta-ease-out) motion-reduce:transition-none forced-colors:border forced-colors:border-current",
            variant === "sidebar" ? "rounded-[6px]" : "rounded-[5px]",
          )}
        />
      )}
      {children}
    </BaseTabs.List>
  );
}

export function TabsTrigger({
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof BaseTabs.Tab>, "className"> & {
  variant?: TabsVariant;
}) {
  return (
    <BaseTabs.Tab
      className={cn(
        "relative z-[1] transition-[color,background-color,scale] duration-(--eta-duration-fast) ease-(--eta-ease-out) motion-reduce:transition-[color,background-color]",
        variant === "inspector"
          ? "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-xs text-subtle outline-none hover:bg-surface-hover/50 hover:text-heading motion-safe:active:scale-[0.94] focus-visible:ring-2 focus-visible:ring-focus-ring-400 disabled:opacity-40 data-active:text-heading [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
          : variant === "sidebar"
            ? "flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-strong outline-none hover:bg-surface-subtle/60 focus-visible:ring-2 focus-visible:ring-focus-ring-400 disabled:opacity-40 data-active:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
            : "flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-strong outline-none hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-focus-ring-400 disabled:opacity-40 data-active:bg-surface-hover/50 [&_svg]:shrink-0",
      )}
      {...props}
    />
  );
}

export function TabsPanel({
  className,
  ...props
}: Omit<ComponentProps<typeof BaseTabs.Panel>, "className"> & { className?: string }) {
  return (
    <BaseTabs.Panel
      className={cn(
        "min-w-0 outline-none motion-safe:[&:not([hidden])]:animate-[eta-tab-enter_var(--eta-duration-normal)_var(--eta-ease-out)]",
        className,
      )}
      {...props}
    />
  );
}
