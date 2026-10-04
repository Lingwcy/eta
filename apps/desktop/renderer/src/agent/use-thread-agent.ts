import type { ImageAttachment } from "../../../src/images/types.ts";
import type { ThinkingLevel } from "../../../src/agent/protocol.ts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { initialAgentState, ThreadAgentClient } from "./client";

const noopSubscribe = () => () => {};
const getInitialState = () => initialAgentState;

export function useThreadAgent(threadId: string | null, version = 0, active = true) {
  const [binding, setBinding] = useState<{ id: string; client: ThreadAgentClient } | null>(null);
  const client = binding?.id === threadId ? binding.client : null;
  useEffect(() => {
    if (!threadId) {
      setBinding(null);
      return;
    }
    const next = new ThreadAgentClient();
    setBinding({ id: threadId, client: next });
    void next.connect(threadId);
    const dispose = () => next.dispose();
    window.addEventListener("pagehide", dispose);
    return () => {
      window.removeEventListener("pagehide", dispose);
      next.dispose();
    };
  }, [threadId, version]);
  const current = useSyncExternalStore(
    active ? (client?.subscribe ?? noopSubscribe) : noopSubscribe,
    client?.getSnapshot ?? getInitialState,
  );
  const state = current;
  const configure = useCallback(
    async (provider: string, modelId: string, thinkingLevel: ThinkingLevel) => {
      if (!client || client.getSnapshot().session?.id !== threadId)
        throw new Error("请先创建或选择会话");
      await client.configure(provider, modelId, thinkingLevel);
    },
    [client, threadId],
  );
  const submit = useCallback(
    async (text: string, images?: readonly ImageAttachment[]) => {
      if (!client || client.getSnapshot().session?.id !== threadId)
        throw new Error("请先创建或选择会话");
      await client.submit(text, images);
    },
    [client, threadId],
  );
  const stop = useCallback(
    () => (client?.getSnapshot().session?.id === threadId ? client.stop() : undefined),
    [client, threadId],
  );
  return { ...state, configure, submit, stop };
}
