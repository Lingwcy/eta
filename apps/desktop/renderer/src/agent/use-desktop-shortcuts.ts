import { useCallback, useEffect } from "react";
import type { DesktopTabs } from "./desktop-tabs";
import { desktopShortcut } from "../../../src/browser/protocol.ts";
import type { DesktopShortcut } from "../../../src/browser/protocol.ts";

export function useDesktopShortcuts(
  tabs: DesktopTabs,
  toggleSidebar: () => void,
  toggleInspector: () => void,
) {
  const run = useCallback(
    (action: DesktopShortcut) => {
      if (typeof action === "object") {
        const open = tabs.getSnapshot().tabs;
        const target = open[action.select === 8 ? open.length - 1 : action.select];
        if (target) tabs.select(target.id);
        return;
      }
      switch (action) {
        case "new-chat":
          tabs.newConversation();
          break;
        case "new-browser":
          tabs.newBrowser();
          break;
        case "close-tab":
          tabs.close(tabs.activeTab.id);
          break;
        case "reopen-tab":
          tabs.reopen();
          break;
        case "settings":
          tabs.openSettings();
          break;
        case "toggle-sidebar":
          toggleSidebar();
          break;
        case "toggle-inspector":
          toggleInspector();
          break;
        case "next-tab":
          tabs.cycle(1);
          break;
        case "previous-tab":
          tabs.cycle(-1);
          break;
        case "focus-address": {
          const active = tabs.activeTab;
          if (active.kind !== "browser") tabs.newBrowser();
          else {
            const input = document.getElementById(`browser-address-${active.id}`);
            if (input instanceof HTMLInputElement) {
              input.focus();
              input.select();
            }
          }
          break;
        }
      }
    },
    [tabs, toggleSidebar, toggleInspector],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const action = desktopShortcut({
        key: event.key,
        meta: event.metaKey,
        control: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
      });
      if (action) {
        event.preventDefault();
        run(action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run]);
  return run;
}
