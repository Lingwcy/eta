import { useEffect, useMemo, useRef, useState } from "react";

interface QueryOwner {
  key: string;
  enabled: boolean;
}
interface QueryRequest {
  owner: QueryOwner;
  revision: string | number;
}

type QueryState<T> =
  | { request: QueryRequest; status: "ready"; value: T }
  | { request: QueryRequest; status: "error" }
  | { request: QueryRequest; status: "loading" };

/** Keep a ready value during refresh, but never across view, resource or reopen admissions. */
export function useDiffQuery<T>(
  key: string,
  enabled: boolean,
  query: () => Promise<T>,
  revision: string | number = 0,
) {
  const owner = useMemo(() => ({ key, enabled }), [key, enabled]);
  const request = useMemo(() => ({ owner, revision }), [owner, revision]);
  const [state, setState] = useState<QueryState<T>>({ request, status: "loading" });
  const read = useRef(query);
  read.current = query;
  useEffect(() => {
    if (!owner.enabled) return;
    const execution = { active: true };
    const execute = read.current;
    setState((previous) =>
      previous.request.owner === owner && previous.status === "ready"
        ? previous
        : { request, status: "loading" },
    );
    void Promise.resolve()
      .then(() => (execution.active ? execute() : undefined))
      .then(
        (value) => {
          if (execution.active && value !== undefined)
            setState({ request, status: "ready", value });
        },
        () => {
          if (execution.active) setState({ request, status: "error" });
        },
      );
    return () => {
      execution.active = false;
    };
  }, [owner, request]);
  return owner.enabled &&
    state.request.owner === owner &&
    (state.request === request || state.status === "ready")
    ? state
    : { request, status: "loading" as const };
}
