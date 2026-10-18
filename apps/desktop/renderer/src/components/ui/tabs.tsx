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
          ? "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[5px] text-xs text-neutral-500 outline-none hover:bg-neutral-200/50 hover:text-neutral-800 focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-40 data-active:text-neutral-800 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
          : variant === "sidebar"
            ? "flex h-7 w-full shrink-0 cursor-pointer items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-40 data-active:bg-neutral-200/70 data-active:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
            : "flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-40 data-active:bg-neutral-200/50 [&_svg]:shrink-0",
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
