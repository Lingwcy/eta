import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { DesktopTabs } from "./desktop-tabs";
import { ThreadActivity } from "./thread-activity";
import { readTabs, persistTabs } from "./tab-storage";

export function useDesktopTabs(library: DesktopLibrary | null) {
  const [windowThread] = useState(() => new URLSearchParams(location.search).get("thread"));
  const [initial] = useState(() => (windowThread ? undefined : readTabs(localStorage)));
  const [tabs] = useState(() => new DesktopTabs(undefined, initial));
  const state = useSyncExternalStore(tabs.subscribe, tabs.getSnapshot);
  const [activity] = useState(() => new ThreadActivity(window.eta));
  const runningThreadIds = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
  const initialized = useRef(false);
  useEffect(() => {
    if (!library || initialized.current) return;
    initialized.current = true;
    if (initial) return;
    const thread = library.threads.find(
      (thread) =>
        thread.id === (windowThread ?? library.settings.activeThreadId) &&
        (windowThread !== null || thread.archivedAt === undefined),
    );
    if (thread) tabs.openThread(thread.id, thread.workspaceId);
  }, [library, initial, tabs, windowThread]);
  useEffect(() => {
    return persistTabs(tabs, windowThread ? sessionStorage : localStorage, window);
  }, [tabs, windowThread]);
  useEffect(() => {
    if (library) tabs.reconcileThreads(library.threads);
  }, [library, tabs]);
  useEffect(() => {
    const dispose = () => activity.dispose();
    window.addEventListener("pagehide", dispose);
    return () => {
      window.removeEventListener("pagehide", dispose);
      dispose();
    };
  }, [activity]);
  return { tabs, state, activity, runningThreadIds };
}

export type DesktopTabController = ReturnType<typeof useDesktopTabs>;
