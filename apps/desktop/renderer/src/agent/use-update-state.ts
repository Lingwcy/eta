import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateState } from "../../../src/bridge.ts";

/**
 * Current app update lifecycle, pushed from the main process. Undefined until the first reply.
 * `versioned` lets a command reply apply only when no push arrived after the caller sampled it:
 * the updater stops pushing once a download settles, so a stale write would hide the install action.
 */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState>();
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    const unsubscribe = window.eta.subscribeUpdate((next) => {
      live = false;
      revision.current += 1;
      setState(next);
    });
    // A pushed state is newer than the initial read, so the read must not overwrite it.
    void window.eta
      .updateState()
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  const capture = useCallback(() => revision.current, []);
  const apply = useCallback((next: UpdateState, at: number) => {
    if (revision.current === at) setState(next);
  }, []);
  return [state, { capture, apply }] as const;
}
