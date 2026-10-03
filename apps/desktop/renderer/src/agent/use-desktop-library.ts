import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";

/** Catalog selection is view state; changing it never closes the selected thread's runtime. */
export function useDesktopLibrary() {
  const [library, setLibrary] = useState<DesktopLibrary | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    const next = await window.eta.library();
    if (mounted.current && epoch === revision.current) setLibrary(next);
    return next;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    void refresh()
      .then((next) => {
        if (stopped) return;
        const selected = next.threads.find(
          (thread) => thread.id === next.settings.activeThreadId && thread.archivedAt === undefined,
        );
        setThreadId(selected?.id ?? null);
        setWorkspaceId(selected?.workspaceId ?? next.workspaces[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!stopped) setError(error instanceof Error ? error.message : "无法读取历史");
      });
    return () => {
      stopped = true;
      mounted.current = false;
      revision.current++;
    };
  }, [refresh]);
  const act = useCallback(
    async (action: () => Promise<void>) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (error) {
        if (mounted.current) setError(error instanceof Error ? error.message : "操作失败");
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh],
  );
  const select = useCallback(
    (id: string) => {
      setThreadId(id);
      setError(null);
      const thread = library?.threads.find((thread) => thread.id === id);
      if (thread) setWorkspaceId(thread.workspaceId);
    },
    [library],
  );
  const newThread = useCallback(
    () =>
      act(async () => {
        if (!workspaceId) throw new Error("请先选择项目工作区");
        const created = await window.eta.createThread(workspaceId, crypto.randomUUID());
        if (mounted.current) setThreadId(created.id);
      }),
    [act, workspaceId],
  );
  const chooseProject = useCallback(
    () =>
      act(async () => {
        const project = await window.eta.chooseProject();
        if (!project) return;
        const next = await refresh();
        if (mounted.current) {
          setWorkspaceId(
            next.workspaces.find((workspace) => workspace.projectId === project.id)?.id ?? null,
          );
          setThreadId(null);
        }
      }),
    [act, refresh],
  );
  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    setThreadId(null);
    setError(null);
  }, []);
  return {
    library,
    threadId,
    workspaceId,
    error,
    busy,
    refresh,
    act,
    select,
    selectWorkspace,
    newThread,
    chooseProject,
  };
}
