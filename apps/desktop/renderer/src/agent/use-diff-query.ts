import { useEffect, useMemo, useRef, useState } from "react";

interface QueryOwner {
  key: string;
  enabled: boolean;
}

type QueryState<T> =
  | { owner: QueryOwner; status: "ready"; value: T }
  | { owner: QueryOwner; status: "error" }
  | { owner: QueryOwner; status: "loading" };

/** A query result belongs to the admitted view, including same-ID reopen and connection changes. */
export function useDiffQuery<T>(key: string, enabled: boolean, query: () => Promise<T>) {
  const owner = useMemo(() => ({ key, enabled }), [key, enabled]);
  const [state, setState] = useState<QueryState<T>>({ owner, status: "loading" });
  const read = useRef(query);
  read.current = query;
  useEffect(() => {
    if (!owner.enabled) return;
    const execution = { active: true };
    const execute = read.current;
    setState({ owner, status: "loading" });
    void Promise.resolve()
      .then(() => (execution.active ? execute() : undefined))
      .then(
        (value) => {
          if (execution.active && value !== undefined) setState({ owner, status: "ready", value });
        },
        () => {
          if (execution.active) setState({ owner, status: "error" });
        },
      );
    return () => {
      execution.active = false;
    };
  }, [owner]);
  return owner.enabled && state.owner === owner ? state : { owner, status: "loading" as const };
}
