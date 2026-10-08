import { useEffect, useState } from "react";
import type { SubagentSummary } from "../../../src/subagents.ts";

/** Observe available inspector content even while the sidebar is collapsed. */
export function useSubagents(threadId?: string, version = 0) {
  const [binding, setBinding] = useState<{
    threadId: string;
    agents: readonly SubagentSummary[];
  }>();
  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    const unsubscribe = window.eta.subscribe(threadId, (event) => {
      if (!disposed && event.type === "snapshot") {
        setBinding({ threadId, agents: event.value.snapshot.subagents ?? [] });
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadId, version]);
  return binding && binding.threadId === threadId ? binding.agents : [];
}
