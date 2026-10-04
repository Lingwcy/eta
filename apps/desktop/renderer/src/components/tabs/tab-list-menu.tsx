import { ThreadContextMenu } from "../threads/thread-actions";
import type { ComponentProps } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown, Globe2, MessageCircle, RotateCcw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DesktopTabs } from "@/agent/desktop-tabs";
import type { TabPresentation } from "@/agent/tab-presentations";
import { TabIcon } from "./tab-icon";

export function TabListMenu({
  tabs,
  items,
  open,
  onOpenChange,
  onSelect,
  triggerId,
}: {
  tabs: DesktopTabs;
  items: readonly TabPresentation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  triggerId: string;
}) {
  const state = tabs.getSnapshot();
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange} triggerId={triggerId} modal={false}>
      <Menu.Trigger
        id={triggerId}
        render={
          <Button variant="ghost-muted" size="icon-xs" aria-label="标签列表" title="标签列表" />
        }
      >
        <ChevronDown size={17} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Menu.Popup
            aria-label="标签操作"
            className="w-72 rounded-2xl border border-neutral-200 bg-white p-2 text-sm shadow-[0_12px_36px_#00000018] outline-none [-webkit-app-region:no-drag]"
          >
            <MenuItem onClick={() => tabs.newConversation()}>
              <MessageCircle size={16} />
              新聊天
              <span className="ml-auto text-xs text-neutral-400">⌘N</span>
            </MenuItem>
            <MenuItem onClick={() => tabs.newBrowser()}>
              <Globe2 size={16} />
              新网页标签
              <span className="ml-auto text-xs text-neutral-400">⌘T</span>
            </MenuItem>
            <MenuItem onClick={() => tabs.openSettings()}>
              <Settings2 size={16} />
              设置
              <span className="ml-auto text-xs text-neutral-400">⌘,</span>
            </MenuItem>
            <MenuItem disabled={!state.closed.length} onClick={() => tabs.reopen()}>
              <RotateCcw size={16} />
              重新打开关闭的标签
              <span className="ml-auto text-xs text-neutral-400">⇧⌘T</span>
            </MenuItem>
            <Menu.Separator className="my-2 border-t border-neutral-100" />
            <div className="max-h-[45vh] overflow-y-auto">
              {items.map((item) => {
                const tab = state.tabs.find((tab) => tab.id === item.id);
                return (
                  <ThreadContextMenu
                    key={item.id}
                    id={tab?.kind === "conversation" ? tab.threadId : undefined}
                  >
                    <MenuItem label={item.title} onClick={() => onSelect(item.id)}>
                      <TabIcon item={item} />
                      <span className="truncate">{item.title}</span>
                      {item.id === state.activeId && (
                        <span className="ml-auto text-xs text-neutral-400">当前</span>
                      )}
                    </MenuItem>
                  </ThreadContextMenu>
                );
              })}
            </div>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MenuItem(props: Omit<ComponentProps<typeof Menu.Item>, "className">) {
  return (
    <Menu.Item
      {...props}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-neutral-700 outline-none data-highlighted:bg-neutral-100 data-disabled:cursor-default data-disabled:opacity-40"
    />
  );
}
