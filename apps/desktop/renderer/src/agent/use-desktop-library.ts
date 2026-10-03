import type { ImageAttachment } from "../../../src/images/types.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { DraftThread } from "./draft-thread";

/** Catalog selection is view state; changing it never closes the selected thread's runtime. */
export function useDesktopLibrary() {
  const [library, setLibrary] = useState<DesktopLibrary | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewKey, setViewKey] = useState("initial");
  const draft = useRef<DraftThread | null>(null);
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
        setWorkspaceId(selected?.workspaceId ?? null);
        if (selected) setViewKey(selected.id);
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
      if (busyRef.current) return;
      setThreadId(id);
      setViewKey(id);
      draft.current = null;
      setError(null);
      const thread = library?.threads.find((thread) => thread.id === id);
      if (thread) setWorkspaceId(thread.workspaceId);
    },
    [library],
  );
  const newThread = useCallback(() => {
    if (busyRef.current || !library) return;
    const id = crypto.randomUUID();
    draft.current = new DraftThread(id, window.eta);
    setViewKey(id);
    setThreadId(null);
    setWorkspaceId(null);
    setError(null);
  }, [library]);
  const submitDraft = useCallback(
    async (prompt: string, images?: readonly ImageAttachment[]) => {
      if (busyRef.current) throw new Error("请等待当前操作完成");
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const current = draft.current ?? new DraftThread(crypto.randomUUID(), window.eta);
      draft.current = current;
      try {
        const id = await current.submit(workspaceId, prompt, images);
        if (mounted.current) setThreadId(id);
      } catch (error) {
        if (mounted.current) {
          if (current.persistedId) setThreadId(current.persistedId);
          setError(error instanceof Error ? error.message : "无法发送消息");
        }
        throw error;
      } finally {
        await refresh().catch(() => {});
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [workspaceId, refresh],
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
          draft.current = null;
          if (threadId) setViewKey(crypto.randomUUID());
        }
      }),
    [act, refresh, threadId],
  );
  const selectWorkspace = useCallback(
    (id: string | null) => {
      if (busyRef.current) return;
      setWorkspaceId(id);
      setThreadId(null);
      draft.current = null;
      if (threadId) setViewKey(crypto.randomUUID());
      setError(null);
    },
    [threadId],
  );
  const registerProject = useCallback(
    async (rootPath: string, name: string) => {
      if (busyRef.current) throw new Error("请等待当前操作完成");
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const project = await window.eta.registerProject(rootPath, name);
        const next = await refresh();
        const workspace = next.workspaces.find(
          (entry) => entry.projectId === project.id && entry.kind === "project-root",
        );
        if (mounted.current) {
          setWorkspaceId(workspace?.id ?? null);
          setThreadId(null);
          draft.current = null;
          if (threadId) setViewKey(crypto.randomUUID());
        }
      } catch (error) {
        if (mounted.current) setError(error instanceof Error ? error.message : "无法创建项目");
        throw error;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh, threadId],
  );
  return {
    library,
    threadId,
    workspaceId,
    error,
    clearError: () => setError(null),
    busy,
    viewKey,
    refresh,
    act,
    select,
    selectWorkspace,
    newThread,
    submitDraft,
    registerProject,
    chooseProject,
  };
}
