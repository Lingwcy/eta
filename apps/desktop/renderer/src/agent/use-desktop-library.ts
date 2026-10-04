import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";

/** Application catalog is shared; each tab owns its own selection and draft. */
export function useDesktopLibrary() {
  const [library, setLibrary] = useState<DesktopLibrary | null>(null);
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
  const reportError = useCallback((error: unknown) => {
    if (mounted.current) setError(error instanceof Error ? error.message : String(error));
  }, []);
  const reload = useCallback(() => {
    void refresh().catch(reportError);
  }, [refresh, reportError]);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, [reload]);
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
        reportError(error);
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [refresh, reportError],
  );
  return { library, error, busy, refresh, reload, act, clearError: () => setError(null) };
}

export type DesktopLibraryController = ReturnType<typeof useDesktopLibrary>;
