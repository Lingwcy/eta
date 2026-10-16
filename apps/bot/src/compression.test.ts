import { gunzipSync } from "node:zlib";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { expect, test } from "vite-plus/test";
import { compressEvents, compressJson } from "./compression.ts";

test("large JSON histories negotiate compression without changing their content", async () => {
  const app = new Hono();
  app.use("*", compressJson, compressEvents);
  const history = {
    transcript: Array.from({ length: 300 }, (_, id) => ({
      id,
      text: "conversation history ".repeat(500),
    })),
  };
  app.get("/thread", (context) => context.json(history));
  const compressed = await app.request("/thread", { headers: { "Accept-Encoding": "gzip" } });
  expect(compressed.headers.get("Content-Encoding")).toBe("gzip");
  expect(compressed.headers.get("Vary")).toContain("Accept-Encoding");
  const bytes = Buffer.from(await compressed.arrayBuffer());
  expect(bytes.length).toBeLessThan(JSON.stringify(history).length / 10);
  expect(JSON.parse(gunzipSync(bytes).toString())).toEqual(history);
  const plain = await app.request("/thread");
  expect(plain.headers.has("Content-Encoding")).toBe(false);
  expect(await plain.json()).toEqual(history);
});

test("gzip SSE flushes a small event before completion and cancels its producer on disconnect", async () => {
  const app = new Hono();
  app.use("*", compressJson, compressEvents);
  const disconnected = Promise.withResolvers<void>();
  app.get("/events", (context) =>
    streamSSE(context, async (stream) => {
      stream.onAbort(() => disconnected.resolve());
      await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ revision: 1 }) });
      await disconnected.promise;
    }),
  );
  const listening = Promise.withResolvers<number>();
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) =>
    listening.resolve(port),
  );
  const abort = new AbortController();
  try {
    const url = `http://127.0.0.1:${await listening.promise}/events`;
    const response = await fetch(url, {
      headers: { "Accept-Encoding": "gzip" },
      signal: abort.signal,
    });
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: {"revision":1}');
    abort.abort();
    await reader.cancel().catch(() => {});
    await disconnected.promise;
    const plainAbort = new AbortController();
    const plain = await fetch(url, {
      headers: { "Accept-Encoding": "gzip;q=0, *;q=1" },
      signal: plainAbort.signal,
    });
    expect(plain.headers.has("Content-Encoding")).toBe(false);
    plainAbort.abort();
    await plain.body?.cancel().catch(() => {});
  } finally {
    abort.abort();
    disconnected.resolve();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
