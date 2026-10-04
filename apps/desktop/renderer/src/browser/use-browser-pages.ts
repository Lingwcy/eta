import { useEffect, useState, useSyncExternalStore } from "react";
import type { DesktopTabs, DesktopTabState } from "@/agent/desktop-tabs";
import type { DesktopShortcut } from "../../../src/browser/protocol.ts";
import { BrowserClient } from "./client";

export function useBrowserPages(
  tabs: DesktopTabs,
  state: DesktopTabState,
  onShortcut: (action: DesktopShortcut) => void,
) {
  const [client] = useState(() => new BrowserClient(window.eta));
  const pages = useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(
    () =>
      client.connect((event) => {
        switch (event.type) {
          case "open":
            tabs.newBrowser(event.url);
            break;
          case "shortcut":
            onShortcut(event.action);
            break;
          case "state":
            if (event.state.url)
              tabs.updateBrowser(event.state.id, {
                url: event.state.url,
                title: event.state.title,
              });
            break;
        }
      }),
    [client, tabs, onShortcut],
  );
  useEffect(() => {
    const { tabs: open, closed } = tabs.getSnapshot();
    client.retain(new Set([...open, ...closed].map((tab) => tab.id)));
  }, [client, tabs, state.closed]);
  const capture = (id: string) => {
    if (pages[id]?.page) void client.command({ type: "capture", id });
  };
  return { client, pages, capture };
}
