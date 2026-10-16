import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { ThreadContextMenu } from "../threads/thread-actions";
import type { ComponentProps } from "react";
import { Menu } from "@base-ui/react/menu";
import { ChevronDown, Globe2, MessageCircle, RotateCcw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { menuPopupStyle } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
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
  useTranslation();
  const state = tabs.getSnapshot();
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange} triggerId={triggerId} modal={false}>
      <Menu.Trigger
        id={triggerId}
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label={t("navigation:tabListMenu.tabList")}
            title={t("navigation:tabListMenu.tabList")}
          />
        }
      >
        <ChevronDown size={17} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            aria-label={t("navigation:tabListMenu.tabActions")}
            className={cn(menuPopupStyle, "w-64 [-webkit-app-region:no-drag]")}
          >
            <MenuItem onClick={() => tabs.newConversation()}>
              <MessageCircle size={16} />
              {t("navigation:tabListMenu.newChat")}
              <span className="ml-auto text-xs text-neutral-400">⌘N</span>
            </MenuItem>
            <MenuItem onClick={() => tabs.newBrowser()}>
              <Globe2 size={16} />
              {t("navigation:tabListMenu.newBrowserTab")}
              <span className="ml-auto text-xs text-neutral-400">⌘T</span>
            </MenuItem>
            <MenuItem onClick={() => tabs.openSettings()}>
              <Settings2 size={16} />
              {t("navigation:tabListMenu.settings")}
              <span className="ml-auto text-xs text-neutral-400">⌘,</span>
            </MenuItem>
            <MenuItem disabled={!state.closed.length} onClick={() => tabs.reopen()}>
              <RotateCcw size={16} />
              {t("navigation:tabListMenu.reopenClosedTab")}
              <span className="ml-auto text-xs text-neutral-400">⇧⌘T</span>
            </MenuItem>
            <Menu.Separator className="mx-1.5 my-1 h-px bg-black/10" />
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
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      {item.id === state.activeId && (
                        <span className="ml-auto text-xs text-neutral-400">
                          {t("navigation:tabListMenu.current")}
                        </span>
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
      className="flex h-[26px] w-full cursor-default items-center gap-1.5 rounded-[5px] px-2 text-left text-xs text-neutral-800 outline-none data-highlighted:bg-[#007aff] data-highlighted:text-white data-disabled:opacity-35 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:stroke-[1.7]"
    />
  );
}
