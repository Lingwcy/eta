import { useEffect, useMemo, useState } from "react";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";
import { ThinkingStatus } from "./thinking-status";

/** Brief phases are suppressed; waiting → thinking keeps an already visible indicator mounted. */
export function useThinkingStatus(threadId: string | null, snapshot?: AgentSnapshot) {
  const [tracker] = useState(() => new ThinkingStatus());
  const phase = useMemo(() => tracker.update(threadId, snapshot), [tracker, threadId, snapshot]);
  const operation = snapshot?.operation;
  const runKey = operation ? `${threadId}:${operation.id}` : null;
  const [shownRun, setShownRun] = useState<string | null>(null);
  useEffect(() => {
    if (!phase || !runKey) {
      setShownRun(null);
      return;
    }
    if (shownRun === runKey) return;
    const timer = window.setTimeout(() => setShownRun(runKey), 150);
    return () => window.clearTimeout(timer);
  }, [phase, runKey, shownRun]);
  return phase && operation && shownRun === runKey
    ? { label: phase === "waiting" ? "等待首次响应" : "正在思考", startedAt: operation.startedAt }
    : null;
}
