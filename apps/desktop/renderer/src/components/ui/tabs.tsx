import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = BaseTabs.Root;
export const TabsList = BaseTabs.List;
export function TabsTrigger({
  variant = "default",
  ...props
}: Omit<ComponentProps<typeof BaseTabs.Tab>, "className"> & {
  variant?: "default" | "inspector" | "sidebar";
}) {
  return (
    <BaseTabs.Tab
      className={cn(
        variant === "inspector"
          ? "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-xs text-subtle outline-none hover:bg-surface-hover/50 hover:text-heading focus-visible:ring-2 focus-visible:ring-focus-ring-400 disabled:opacity-40 data-active:text-heading [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
          : variant === "sidebar"
            ? "flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-strong outline-none hover:bg-surface-subtle focus-visible:ring-2 focus-visible:ring-focus-ring-400 disabled:opacity-40 data-active:bg-surface-hover/70 data-active:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
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
  return <BaseTabs.Panel className={cn("min-w-0 outline-none", className)} {...props} />;
}
