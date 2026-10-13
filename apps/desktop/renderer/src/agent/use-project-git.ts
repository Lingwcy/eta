import { useCallback, useEffect, useRef, useState } from "react";
import type { GitRepositoryInfo } from "@eta/core/shared/git";

/** Per-workspace snapshots keep header capability checks cached, with explicit and focus refreshes. */
export function useProjectGit(workspaceId: string | undefined, enabled: boolean, revision: number) {
  const [entries, setEntries] = useState<
    Record<string, { info: GitRepositoryInfo; checkedAt: number }>
  >({});
  const requests = useRef(new Map<string, number>());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const load = useCallback(
    async (force = true) => {
      if (!workspaceId || !enabled) return;
      const cached = entriesRef.current[workspaceId];
      if (!force && cached && Date.now() - cached.checkedAt < 60_000) return;
      const version = (requests.current.get(workspaceId) ?? 0) + 1;
      requests.current.set(workspaceId, version);
      let info: GitRepositoryInfo;
      try {
        info = await window.eta.gitRepository(workspaceId);
      } catch {
        return;
      }
      if (requests.current.get(workspaceId) === version)
        setEntries((current) => ({ ...current, [workspaceId]: { info, checkedAt: Date.now() } }));
    },
    [workspaceId, enabled],
  );
  useEffect(() => {
    void load(false);
  }, [load]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision;
      void load();
    }
  }, [revision, load]);
  useEffect(() => {
    const refresh = () => {
      void load();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);
  return { info: workspaceId ? entries[workspaceId]?.info : undefined, refresh: load };
}
