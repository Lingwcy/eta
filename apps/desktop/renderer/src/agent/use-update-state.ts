import { useEffect, useState } from "react";
import type { UpdateState } from "../../../src/bridge.ts";

/** Current app update lifecycle, pushed from the main process. Undefined until the first reply. */
export function useUpdateState() {
  const [state, setState] = useState<UpdateState>();
  useEffect(() => {
    let live = true;
    const unsubscribe = window.eta.subscribeUpdate((next) => {
      live = false;
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
  return [state, setState] as const;
}
