import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";
import { hasThreadActivity, ThreadActivity } from "./thread-activity";

export function useThreadActivity(
  threadId: string | null,
  snapshot: AgentSnapshot | undefined,
  pending: boolean,
) {
  const [activity] = useState(() => new ThreadActivity(window.eta));
  const active = snapshot ? hasThreadActivity(snapshot) : false;
  const running = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
  useEffect(() => {
    if (threadId && active) activity.watch(threadId);
  }, [activity, threadId, active]);
  useEffect(() => {
    const dispose = () => activity.dispose();
    window.addEventListener("pagehide", dispose);
    return () => {
      window.removeEventListener("pagehide", dispose);
      dispose();
    };
  }, [activity]);
  return useMemo(() => {
    if (!threadId || !pending || running.has(threadId)) return running;
    return new Set([...running, threadId]);
  }, [running, threadId, pending]);
}
