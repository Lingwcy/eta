import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceChanges } from "@eta/core/shared/diff";
import type { FileDiffSelection } from "./file-diff-actions";
import { useDiffQuery } from "./use-diff-query";

export function useWorkspaceDiff({
  workspaceId,
  connectionKey,
  revision = 0,
  enabled,
}: {
  workspaceId?: string;
  connectionKey: string;
  revision?: number;
  enabled: boolean;
}) {
  const identity = JSON.stringify([connectionKey, workspaceId]);
  const admitted = enabled && Boolean(workspaceId);
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const query = useDiffQuery<WorkspaceChanges>(
    identity,
    admitted,
    () => window.eta.workspaceChanges({ workspaceId: workspaceId!, scope: "all" }),
    generation,
  );
  const [known, setKnown] = useState<{ identity: string; available: boolean }>();
  const available =
    admitted &&
    (query.status === "ready"
      ? query.value.status === "ready" && query.value.files.length > 0
      : known?.identity === identity && known.available);
  useEffect(() => {
    if (query.status !== "ready") return;
    setKnown({
      identity,
      available: query.value.status === "ready" && query.value.files.length > 0,
    });
  }, [identity, query.status, query.status === "ready" ? query.value : undefined]);
  const previous = useRef({ identity, revision });
  useEffect(() => {
    const before = previous.current;
    previous.current = { identity, revision };
    if (!admitted || before.identity !== identity || before.revision === revision) return;
    const timer = setTimeout(refresh, 100);
    return () => clearTimeout(timer);
  }, [admitted, identity, revision, refresh]);
  useEffect(() => {
    if (!admitted) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [admitted, identity, refresh]);
  // A patch refresh must use a completed list, never the previous revision while its read is pending.
  return { ...query, available: Boolean(available), generation: query.request.revision, refresh };
}

export type WorkspaceDiffQuery = ReturnType<typeof useWorkspaceDiff>;

/** Current-workspace entry points require real changes; explicit saved history is independent. */
export function useCodeDiff({
  workspaceId,
  threadId,
  connectionKey,
  revision,
  supported,
  onOpen,
}: {
  workspaceId?: string;
  threadId?: string;
  connectionKey: string;
  revision: number;
  supported: boolean;
  onOpen: () => void;
}) {
  const [selection, setSelection] = useState<
    FileDiffSelection & { connectionKey: string; requestId: string }
  >();
  const canOpenHistory = supported && Boolean(threadId);
  const history =
    canOpenHistory &&
    selection &&
    selection.threadId === threadId &&
    selection.connectionKey === connectionKey
      ? selection
      : undefined;
  const workspace = useWorkspaceDiff({
    workspaceId: history?.workspaceId ?? workspaceId,
    connectionKey,
    revision,
    enabled: supported,
  });
  return {
    available: supported && (workspace.available || Boolean(history)),
    canOpenHistory,
    workspaceId: history?.workspaceId ?? workspaceId,
    history,
    workspace,
    showWorkspace: () => setSelection(undefined),
    open: (target: FileDiffSelection) => {
      if (!canOpenHistory || target.threadId !== threadId) return;
      setSelection({ ...target, connectionKey, requestId: crypto.randomUUID() });
      onOpen();
    },
  };
}
