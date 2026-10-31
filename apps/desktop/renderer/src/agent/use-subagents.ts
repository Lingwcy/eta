import { useEffect, useState } from "react";
import type { SubagentSummary } from "@eta/core/shared/subagents";

/** Share the inspector observation; streamed tokens never invalidate workspace diffs. */
export function useSubagents(threadId?: string, version = 0) {
  const [binding, setBinding] = useState<{
    threadId: string;
    agents: readonly SubagentSummary[];
    revision: number;
  }>();
  useEffect(() => {
    if (!threadId) return;
    let disposed = false;
    let stamp: string | undefined;
    let revision = 0;
    const unsubscribe = window.eta.subscribe(threadId, (event) => {
      if (!disposed && event.type === "snapshot") {
        const snapshot = event.value.snapshot;
        const agents = snapshot.subagents ?? [];
        const nextStamp = JSON.stringify([
          snapshot.lastResult?.operationId,
          snapshot.lastResult?.endedAt,
          snapshot.operation?.id,
          snapshot.operation?.runningTools
            .filter((tool) =>
              ["edit", "write", "bash", "powershell", "codemode"].includes(tool.toolName),
            )
            .map((tool) => [tool.taskId ?? tool.toolCallId, tool.status]),
          agents.map((agent) => [agent.path, agent.status]),
        ]);
        if (stamp !== undefined && stamp !== nextStamp) revision++;
        stamp = nextStamp;
        setBinding({ threadId, agents, revision });
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadId, version]);
  return binding && binding.threadId === threadId ? binding : { agents: [], revision: 0 };
}
