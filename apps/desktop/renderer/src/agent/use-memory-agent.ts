import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { initialAgentState, MemoryAgentClient } from "./client";

const noopSubscribe = () => () => {};
const getInitialState = () => initialAgentState;

export function useMemoryAgent() {
  const [client, setClient] = useState<MemoryAgentClient | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const next = new MemoryAgentClient();
    setClient(next);
    void next.connect();
    const dispose = () => next.dispose();
    window.addEventListener("pagehide", dispose);
    return () => {
      window.removeEventListener("pagehide", dispose);
      next.dispose();
    };
  }, [version]);
  const state = useSyncExternalStore(
    client?.subscribe ?? noopSubscribe,
    client?.getSnapshot ?? getInitialState,
  );
  const newSession = useCallback(() => setVersion((current) => current + 1), []);
  const submit = useCallback(
    async (text: string) => {
      if (!client) throw new Error("Agent 尚未就绪");
      await client.submit(text);
    },
    [client],
  );
  const stop = useCallback(() => client?.stop(), [client]);
  return { ...state, submit, stop, newSession };
}
