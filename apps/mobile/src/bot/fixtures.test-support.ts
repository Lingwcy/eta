import { z } from "zod";
import { LibrarySchema, OpenThreadSchema } from "./contracts.ts";
import type { MobileCache, MobileStorage } from "./store.ts";
import type { Connection } from "./contracts.ts";

export const library = LibrarySchema.parse({
  projects: [{ id: "project", name: "Workspace", rootPath: "/work" }],
  workspaces: [{ id: "workspace", projectId: "project", cwd: "/work", kind: "project-root" }],
  threads: [],
  models: [{ id: "one", name: "Test model", provider: "test", thinkingLevels: ["off", "medium"] }],
  settings: { defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off" },
  allowedSandboxModes: ["read-only", "workspace-write"],
});
export const thread = OpenThreadSchema.parse({
  id: "thread",
  model: library.models[0],
  contextTokens: 0,
  thread: {
    id: "thread",
    workspaceId: "workspace",
    projectId: "project",
    title: "Thread",
    createdAt: 1,
  },
  snapshot: {
    configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
    transcript: [],
    operation: null,
    lastResult: null,
    faulted: false,
  },
});

export function memoryStorage(initial?: Connection) {
  let savedConnection = initial;
  const caches = new Map<string, MobileCache>();
  const storage: MobileStorage = {
    async connection() {
      return savedConnection;
    },
    async saveConnection(value) {
      savedConnection = value;
    },
    async cache(url) {
      return structuredClone(caches.get(url));
    },
    async saveCache(url, value) {
      caches.set(url, structuredClone(value));
    },
    async clear() {
      savedConnection = undefined;
      caches.clear();
    },
  };
  return { storage, caches, connection: () => savedConnection };
}

export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function requestUrl(value: Parameters<typeof fetch>[0]) {
  return typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
}

export function requestBody(init?: RequestInit) {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON string request body");
  return z.object({ requestId: z.string().optional() }).passthrough().parse(JSON.parse(init.body));
}

export function events(signal?: AbortSignal | null) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal?.aborted) {
          controller.close();
          return;
        }
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.close();
            } catch {
              /* Already cancelled. */
            }
          },
          { once: true },
        );
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
