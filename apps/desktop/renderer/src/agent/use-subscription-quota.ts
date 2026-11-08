import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionQuota } from "@eta/core/shared/subscription-quota";

type State = {
  quota: SubscriptionQuota | null | undefined;
  loading: boolean;
  failed: boolean;
};

/** Read only for the connection owned by this mounted view. */
export function useSubscriptionQuota(
  providerId: string,
  connectionId: string,
  autoRefresh = false,
) {
  const [state, setState] = useState<State>({ quota: undefined, loading: true, failed: false });
  const owner = useRef<object | undefined>(undefined);
  const busy = useRef(false);

  const read = useCallback(
    async (refresh: boolean, admission: object) => {
      if (busy.current || owner.current !== admission) return;
      busy.current = true;
      setState((current) => ({ ...current, loading: true, failed: false }));
      try {
        const quota = await window.eta.subscriptionQuota(providerId, connectionId, refresh);
        if (owner.current === admission) {
          if (quota && (quota.providerId !== providerId || quota.connectionId !== connectionId)) {
            setState({ quota: null, loading: false, failed: false });
            return null;
          }
          setState({ quota, loading: false, failed: false });
          return quota;
        }
      } catch {
        if (owner.current === admission)
          setState((current) => ({ ...current, loading: false, failed: true }));
      } finally {
        if (owner.current === admission) busy.current = false;
      }
    },
    [providerId, connectionId],
  );

  useEffect(() => {
    const admission = {};
    owner.current = admission;
    busy.current = false;
    setState({ quota: undefined, loading: true, failed: false });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const poll = async (initial = false) => {
      if (polling || owner.current !== admission) return;
      polling = true;
      clearTimeout(timeout);
      let delay = 60_000;
      try {
        if (initial || document.visibilityState === "visible") {
          const quota = await read(false, admission);
          // Cached reads (including focus) must not postpone the existing TTL deadline.
          if (quota?.status === "ready" && quota.readAt !== undefined)
            delay = Math.max(1000, Math.min(60_000, quota.readAt + 60_000 - Date.now()));
        }
      } finally {
        polling = false;
        if (autoRefresh && owner.current === admission)
          timeout = setTimeout(() => void poll(), delay);
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    void poll(true);
    if (autoRefresh) {
      window.addEventListener("focus", refreshVisible);
      document.addEventListener("visibilitychange", refreshVisible);
    }
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
      if (owner.current === admission) owner.current = undefined;
    };
  }, [read, autoRefresh]);

  return {
    ...state,
    refresh: () => {
      if (owner.current) void read(true, owner.current);
    },
  };
}
