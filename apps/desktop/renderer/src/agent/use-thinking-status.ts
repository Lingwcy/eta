import { t } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { ThinkingStatus } from "./thinking-status";

const labels = () => ({
  waiting: t("chat:useThinkingStatus.waitingForTheFirstResponse"),
  continuing: t("chat:useThinkingStatus.waitingForTheNextResponse"),
  thinking: t("chat:useThinkingStatus.thinking"),
  retrying: t("chat:useThinkingStatus.retryingTheResponse"),
  deferred: t("chat:useThinkingStatus.waitingForABackgroundResponse"),
  subagents: t("chat:useThinkingStatus.waitingForSubagents"),
});

/** Brief phases are suppressed; visible phase changes keep the indicator mounted. */
export function useThinkingStatus(threadId: string | null, snapshot?: AgentSnapshot) {
  const [tracker] = useState(() => new ThinkingStatus());
  const { phase, startedAt } = useMemo(
    () => ({ phase: tracker.update(threadId, snapshot), startedAt: tracker.startedAt }),
    [tracker, threadId, snapshot],
  );
  const operation = snapshot?.operation;
  const runKey = operation
    ? `${threadId}:${operation.id}`
    : phase === "subagents"
      ? `${threadId}:subagents`
      : null;
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
  return phase && shownRun === runKey
    ? { label: labels()[phase], startedAt, waiting: phase !== "thinking" }
    : null;
}
