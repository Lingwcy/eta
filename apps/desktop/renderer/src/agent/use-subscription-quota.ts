import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionQuota } from "@eta/core/shared/subscription-quota";

type State = {
  quota: SubscriptionQuota | null | undefined;
  loading: boolean;
  failed: boolean;
};

/** Read only for the connection owned by this mounted view. */
export function useSubscriptionQuota(providerId: string, connectionId: string) {
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
            return;
          }
          setState({ quota, loading: false, failed: false });
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
    void read(false, admission);
    return () => {
      if (owner.current === admission) owner.current = undefined;
    };
  }, [read]);

  return {
    ...state,
    refresh: () => {
      if (owner.current) void read(true, owner.current);
    },
  };
}
