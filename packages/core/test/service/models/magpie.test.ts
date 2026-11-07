import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vite-plus/test";
import { loadMagpieProvider } from "../../../src/service/models/magpie.ts";

test("optional configuration rejects non-loopback and never leaks its key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eta-magpie-"));
  const path = join(dir, "config.json");
  try {
    expect(await loadMagpieProvider({ path })).toBeUndefined();
    await writeFile(
      path,
      JSON.stringify({ version: 1, baseUrl: "http://example.com", apiKey: "private-key" }),
    );
    await expect(loadMagpieProvider({ path })).rejects.toThrow("Invalid Magpie configuration");
    await writeFile(path, "private-key{");
    await expect(loadMagpieProvider({ path })).rejects.toThrow("Invalid Magpie configuration");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refresh verifies hello, uses configured key and retains catalog on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eta-magpie-"));
  const path = join(dir, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:3425", apiKey: "secret" }),
    );
    let fail = false;
    const requests: Array<[string, string | null]> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push([url, new Headers(init?.headers).get("authorization")]);
      if (fail) return Response.json({ name: "other", version: "1" });
      if (url.endsWith("/api/hello")) return Response.json({ name: "magpie", version: "1" });
      return Response.json({
        data: [
          {
            id: "local/model",
            display_name: "Local",
            context_window: 32768,
            max_output_tokens: 4096,
          },
        ],
      });
    };
    const provider = await loadMagpieProvider({ path, fetch: fetcher });
    expect(provider).toBeDefined();
    const models = createModels();
    models.setProvider(provider!);
    expect((await models.refresh()).errors.size).toBe(0);
    expect(requests).toEqual([
      ["http://127.0.0.1:3425/api/hello", null],
      ["http://127.0.0.1:3425/v1/models", "Bearer secret"],
    ]);
    expect(models.getModel("magpie", "local/model")).toMatchObject({
      name: "Local",
      contextWindow: 32768,
      maxTokens: 4096,
      reasoning: false,
    });
    fail = true;
    expect((await models.refresh()).errors.size).toBe(1);
    expect(models.getModel("magpie", "local/model")).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real completions stream forwards the provider session and configured key", async () => {
  const { createServer } = await import("node:http");
  const dir = await mkdtemp(join(tmpdir(), "eta-magpie-"));
  const path = join(dir, "config.json");
  let received: { url?: string; session?: string | string[]; authorization?: string } = {};
  const server = createServer((req, res) => {
    received = {
      url: req.url,
      session: req.headers["x-magpie-session"],
      authorization: req.headers.authorization,
    };
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server unavailable");
    await writeFile(
      path,
      JSON.stringify({ version: 1, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "secret" }),
    );
    const fetcher: typeof fetch = async (input) =>
      (input instanceof Request ? input.url : input.toString()).endsWith("/api/hello")
        ? Response.json({ name: "magpie", version: "1" })
        : Response.json({ data: [{ id: "__proto__" }, { id: "constructor" }] });
    const provider = await loadMagpieProvider({ path, fetch: fetcher });
    const models = createModels();
    models.setProvider(provider!);
    expect((await models.refresh()).errors.size).toBe(0);
    for (const id of ["__proto__", "constructor"]) {
      const model = models.getModel("magpie", id)!;
      const result = await models
        .streamSimple(
          model,
          {
            messages: [
              { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
            ],
          },
          { sessionId: "session-123" },
        )
        .result();
      expect(result.stopReason).toBe("stop");
      expect(received).toEqual({
        url: "/v1/chat/completions",
        session: "session-123",
        authorization: "Bearer secret",
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects invalid keys, oversized configuration, and invalid catalog limits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eta-magpie-"));
  const path = join(dir, "config.json");
  const config = (apiKey: string) =>
    JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:3425", apiKey });
  try {
    for (const key of ["a b", "a\tb", "中文", "a\nb"]) {
      await writeFile(path, config(key));
      await expect(loadMagpieProvider({ path })).rejects.toThrow("Invalid Magpie configuration");
    }
    await writeFile(path, " ".repeat(65537));
    await expect(loadMagpieProvider({ path })).rejects.toThrow("Invalid Magpie configuration");
    await writeFile(path, config("secret"));
    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const fetcher: typeof fetch = async (input) =>
        (input instanceof Request ? input.url : input.toString()).endsWith("hello")
          ? Response.json({ name: "magpie", version: "1" })
          : new Response(
              `{"data":[{"id":"m","context_window":${invalid === Infinity ? "1e999" : invalid}}]}`,
            );
      const models = createModels();
      models.setProvider((await loadMagpieProvider({ path, fetch: fetcher }))!);
      expect((await models.refresh()).errors.size).toBe(1);
      expect(models.getModels()).toEqual([]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fragmented catalog, special IDs, capability limits and oversized response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eta-magpie-"));
  const path = join(dir, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:3425", apiKey: "secret" }),
    );
    let oversized = false;
    const fetcher: typeof fetch = async (input) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith("hello"))
        return Response.json({ name: "magpie", version: "1" });
      const data = new TextEncoder().encode(
        oversized
          ? "x".repeat(1024 * 1024 + 1)
          : JSON.stringify({
              data: [
                {
                  id: "__proto__",
                  reasoning: true,
                  reasoning_levels: ["low", "high"],
                  modalities: { input: ["text", "image"] },
                },
                { id: "constructor" },
              ],
            }),
      );
      let offset = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (offset === data.length) {
              controller.close();
              return;
            }
            const end = Math.min(data.length, offset + (oversized ? 1024 : 1));
            controller.enqueue(data.subarray(offset, end));
            offset = end;
          },
        }),
      );
    };
    const models = createModels();
    models.setProvider((await loadMagpieProvider({ path, fetch: fetcher }))!);
    expect((await models.refresh()).errors.size).toBe(0);
    expect(models.getModel("magpie", "constructor")).toBeDefined();
    expect(models.getModel("magpie", "__proto__")).toMatchObject({
      input: ["text", "image"],
      thinkingLevelMap: { low: "low", medium: null, high: "high" },
    });
    oversized = true;
    expect((await models.refresh()).errors.size).toBe(1);
    expect(models.getModel("magpie", "constructor")).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled refresh aborts the catalog request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eta-magpie-"));
  const path = join(dir, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:3425", apiKey: "secret" }),
    );
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith("hello"))
        return Response.json({ name: "magpie", version: "1" });
      requestSignal = init?.signal ?? undefined;
      entered();
      return await new Promise<Response>((_resolve, reject) =>
        requestSignal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    };
    const models = createModels();
    models.setProvider((await loadMagpieProvider({ path, fetch: fetcher }))!);
    const controller = new AbortController();
    const refresh = models.refresh({ signal: controller.signal });
    await started;
    controller.abort();
    expect((await refresh).aborted).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugin home config wins over legacy XDG and disconnect does not resurrect it", async () => {
  const home = await mkdtemp(join(tmpdir(), "eta-plugin-home-"));
  const xdg = join(home, "custom-config");
  const canonical = join(home, ".config", "eta", "magpie.json");
  const legacy = join(xdg, "eta", "magpie.json");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CONFIG_HOME", xdg);
  try {
    await mkdir(join(home, ".config", "eta"), { recursive: true });
    await mkdir(join(xdg, "eta"), { recursive: true });
    const config = (port: number) =>
      JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:" + port, apiKey: "magpie-eta" });
    await writeFile(canonical, config(17));
    await writeFile(legacy, config(18));
    const requested: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      return Response.json(
        url.endsWith("/api/hello") ? { name: "magpie", version: "fixture" } : { data: [] },
      );
    };
    const refresh = async () => {
      const provider = await loadMagpieProvider({ fetch: fetcher });
      expect(provider).toBeDefined();
      const models = createModels();
      models.setProvider(provider!);
      expect((await models.refresh()).errors.size).toBe(0);
    };
    await refresh();
    expect(requested[0]).toBe("http://127.0.0.1:17/api/hello");
    await writeFile(canonical, "{");
    await expect(loadMagpieProvider()).rejects.toThrow("Invalid Magpie configuration");
    for (const restored of ["{}", '{"unrelated":true}']) {
      await writeFile(canonical, restored);
      expect(await loadMagpieProvider()).toBeUndefined();
    }
    await rm(canonical);
    requested.length = 0;
    await refresh();
    expect(requested[0]).toBe("http://127.0.0.1:18/api/hello");
    await rm(legacy);
    expect(await loadMagpieProvider()).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
