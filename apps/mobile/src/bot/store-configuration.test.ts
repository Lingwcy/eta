import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vite-plus/test";
import { BotClient } from "./client.ts";
import { MobileStore } from "./store.ts";
import { OpenThreadSchema, type Configuration } from "./contracts.ts";
import { json, library, memoryStorage, requestUrl, thread } from "./fixtures.test-support.ts";

type Mode = Configuration["sandboxMode"];
const changes: { initial: Mode; next: Mode }[] = [
  { initial: "workspace-write", next: "read-only" },
  { initial: "read-only", next: "workspace-write" },
  { initial: "read-only", next: "danger-full-access" },
  { initial: "read-only", next: undefined },
  { initial: undefined, next: "read-only" },
  { initial: "read-only", next: "read-only" },
];
const modes = ["read-only", "workspace-write", "danger-full-access"] as const;

test.each(changes.flatMap((change) => [false, true].map((active) => ({ ...change, active }))))(
  "SSE configuration: $initial -> $next, coalesced=$active",
  async ({ initial, next, active }) => {
    vi.useFakeTimers();
    const saved = memoryStorage();
    const requests: string[] = [];
    let subscribed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const opened = OpenThreadSchema.parse({
      ...thread,
      snapshot: {
        ...thread.snapshot,
        sandbox: initial ? { mode: initial, available: true, allowedModes: modes } : undefined,
      },
    });
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      requests.push(path);
      if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
      if (path.endsWith("/events")) {
        subscribed = true;
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return json(opened);
    };
    let requestId = 0;
    const store = new MobileStore(
      saved.storage,
      (connection) => new BotClient(connection, fetcher),
      () => `request-${++requestId}`,
    );
    try {
      await store.connect({ url: "https://bot", token: "test-token" });
      await store.open(thread.id);
      await vi.waitFor(() => expect(subscribed).toBe(true), { timeout: 1000 });
      expect(store.getSnapshot().configuration?.sandboxMode).toBe(initial);
      const payload = {
        contextTokens: 42,
        snapshot: {
          ...opened.snapshot,
          sandbox: next ? { mode: next, available: true, allowedModes: modes } : undefined,
          configuration: { ...opened.snapshot.configuration, thinkingLevel: "medium" },
          operation: active ? { id: "operation", status: "running", runningTools: [] } : null,
        },
      };
      controller?.enqueue(
        new TextEncoder().encode("event: snapshot\ndata: " + JSON.stringify(payload) + "\n\n"),
      );
      await setImmediate();
      if (active) await vi.advanceTimersByTimeAsync(80);
      expect(store.getSnapshot().thread?.contextTokens).toBe(42);
      expect(store.getSnapshot().thread?.snapshot.sandbox?.mode).toBe(next);
      expect(store.getSnapshot().configuration).toMatchObject({
        provider: "test",
        modelId: "one",
        thinkingLevel: "medium",
      });
      expect(store.getSnapshot().configuration?.sandboxMode).toBe(next);
      store.newThread();
      expect(store.getSnapshot().configuration?.sandboxMode).toBe(next);
      const url = store.getSnapshot().url!;
      await store.disconnect();
      expect(saved.caches.get(url)?.lastConfiguration?.sandboxMode).toBe(next);
      expect(
        requests.some((path) => path.endsWith("/sandbox") || path.endsWith("/configure")),
      ).toBe(false);
    } finally {
      store.dispose();
      await setImmediate();
      vi.useRealTimers();
    }
  },
);
