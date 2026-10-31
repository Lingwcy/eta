// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { AgentEvent } from "../../../src/bridge.ts";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { useSubagents } from "./use-subagents";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("workspace invalidation follows tool completion, not streamed tokens, and rejects old observations", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observers: Array<(event: AgentEvent) => void> = [];
  const stops = vi.fn();
  vi.stubGlobal("eta", {
    subscribe: (_id: string, listener: (event: AgentEvent) => void) => {
      observers.push(listener);
      return stops;
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function View({ threadId }: { threadId: string }) {
    const state = useSubagents(threadId);
    return createElement(
      "output",
      null,
      `${state.revision}:${state.agents.map((agent) => agent.path).join(",")}`,
    );
  }
  const snapshot: AgentSnapshot = {
    configuration: { model: { provider: "test", modelId: "test" }, thinkingLevel: "off" },
    transcript: [],
    lastResult: null,
    faulted: false,
    operation: {
      id: "operation",
      kind: "run",
      startedAt: 1,
      status: "running",
      fromTipId: null,
      runningTools: [{ toolCallId: "edit", toolName: "edit", args: {}, status: "running" }],
    },
  };
  const publish = async (listener: (event: AgentEvent) => void, value: AgentSnapshot) =>
    act(async () => listener({ type: "snapshot", value: { snapshot: value, contextTokens: 0 } }));
  await act(async () => root!.render(createElement(View, { threadId: "first" })));
  await publish(observers[0]!, snapshot);
  expect(container.textContent).toBe("0:");
  await publish(observers[0]!, {
    ...snapshot,
    transcript: [
      {
        id: "streamed",
        type: "message",
        message: { role: "user", content: "a later token", timestamp: 10 },
      },
    ],
  });
  expect(container.textContent).toBe("0:");
  await publish(observers[0]!, {
    ...snapshot,
    operation: { ...snapshot.operation!, runningTools: [] },
  });
  expect(container.textContent).toBe("1:");
  await publish(observers[0]!, {
    ...snapshot,
    operation: {
      ...snapshot.operation!,
      runningTools: [{ toolCallId: "read", toolName: "read", args: {}, status: "running" }],
    },
  });
  expect(container.textContent).toBe("1:");
  await publish(observers[0]!, {
    ...snapshot,
    operation: { ...snapshot.operation!, runningTools: [] },
  });
  expect(container.textContent).toBe("1:");
  await act(async () => root!.render(createElement(View, { threadId: "second" })));
  expect(stops).toHaveBeenCalledOnce();
  expect(container.textContent).toBe("0:");
  await publish(observers[0]!, snapshot);
  expect(container.textContent).toBe("0:");
  await publish(observers[1]!, { ...snapshot, operation: null });
  expect(container.textContent).toBe("0:");
});
