import { useEffect, useMemo, useState } from "react";
import type { AgentSnapshot } from "../../../src/agent/protocol.ts";
import { ThinkingStatus } from "./thinking-status";

const labels = {
  waiting: "等待首次响应",
  continuing: "等待下一步响应",
  thinking: "正在思考",
  retrying: "正在重试响应",
  deferred: "等待后台响应",
  subagents: "等待子任务",
};

/** Brief phases are suppressed; visible phase changes keep the indicator mounted. */
export function useThinkingStatus(threadId: string | null, snapshot?: AgentSnapshot) {
  const [tracker] = useState(() => new ThinkingStatus());
  const { phase, startedAt } = useMemo(
    () => ({ phase: tracker.update(threadId, snapshot), startedAt: tracker.startedAt }),
    [tracker, threadId, snapshot],
  );
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
    ? { label: labels[phase], startedAt, waiting: phase !== "thinking" }
    : null;
}
