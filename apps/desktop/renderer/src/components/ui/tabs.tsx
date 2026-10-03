import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export const Tabs = BaseTabs.Root;
export const TabsList = BaseTabs.List;
export function TabsTrigger(props: Omit<ComponentProps<typeof BaseTabs.Tab>, "className">) {
  return (
    <BaseTabs.Tab
      className="flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-neutral-700 outline-none hover:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-neutral-400 disabled:opacity-40 data-active:bg-neutral-200/50 [&_svg]:shrink-0"
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
