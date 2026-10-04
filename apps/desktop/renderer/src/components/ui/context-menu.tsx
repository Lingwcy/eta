import { ContextMenu as BaseMenu } from "@base-ui/react/context-menu";
import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export const ContextMenu = BaseMenu.Root;
export const ContextMenuTrigger = BaseMenu.Trigger;
export const ContextMenuSubmenu = BaseMenu.SubmenuRoot;

const itemStyle =
  "flex h-[26px] cursor-default items-center gap-1.5 rounded-[5px] px-2 outline-none data-highlighted:bg-[#007aff] data-highlighted:text-white data-disabled:opacity-35 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]";

export function ContextMenuContent({
  children,
  submenu = false,
}: {
  children: ReactNode;
  submenu?: boolean;
}) {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        side={submenu ? "inline-end" : "bottom"}
        align="start"
        // Submenus anchor to the inset row, so include the popup's padding and border.
        sideOffset={submenu ? 12 : 4}
        alignOffset={submenu ? -5 : 0}
        collisionPadding={8}
        collisionAvoidance={
          submenu ? { side: "flip", align: "shift", fallbackAxisSide: "none" } : undefined
        }
        className="z-50"
      >
        <BaseMenu.Popup className="max-h-[var(--available-height)] w-40 overflow-y-auto rounded-[10px] border border-black/12 bg-[#f8f8f8]/95 p-1 text-xs font-normal text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] outline-none backdrop-blur-xl select-none">
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  );
}
export function ContextMenuItem({
  destructive = false,
  ...props
}: ComponentProps<typeof BaseMenu.Item> & { destructive?: boolean }) {
  return (
    <BaseMenu.Item
      {...props}
      className={`${itemStyle} ${destructive ? "text-red-600" : "text-neutral-800"}`}
    />
  );
}
export function ContextMenuSubmenuTrigger({
  children,
  ...props
}: ComponentProps<typeof BaseMenu.SubmenuTrigger>) {
  return (
    <BaseMenu.SubmenuTrigger {...props} className={`${itemStyle} text-neutral-800`}>
      {children}
      <ChevronRight size={14} className="ml-auto" />
    </BaseMenu.SubmenuTrigger>
  );
}
export function ContextMenuSeparator() {
  return <BaseMenu.Separator className="mx-1.5 my-1 h-px bg-black/10" />;
}
