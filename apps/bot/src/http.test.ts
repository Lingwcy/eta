import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { serve } from "@hono/node-server";
import { defineTask } from "@eta/agent";
import type { CoreEnvironment } from "@eta/core";
import { afterEach, expect, test } from "vite-plus/test";
import { createBotApplication } from "./application.ts";
import type { BotApplication } from "./application.ts";
import type { BotConfig } from "./config.ts";

const bots: BotApplication[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const identity = Schema.Struct({ id: Schema.String });
const admission = Schema.Struct({ operationId: Schema.String });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-http-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "bot-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "bot-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const models = createModels();
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titles.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const config: BotConfig = {
    dataRoot: join(root, "data"),
    adminToken: "test-admin-token",
    projects: [{ key: "test", rootPath: cwd }],
    runtime: { defaultThinkingLevel: "off" },
  };
  const open = async (environment?: Partial<CoreEnvironment>) => {
    const bot = await createBotApplication(config, {
      models,
      ...(environment ? { environment } : {}),
    });
    bots.push(bot);
    return bot;
  };
  const bot = await open();
  const workspace = [...bot.workspaceProjects.keys()][0]!;
  const request = (path: string, body?: object) =>
    bot.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (key: string) => {
    const response = await request("/v1/threads", { workspaceId: workspace, requestId: key });
    expect(response.status).toBe(201);
    return Schema.decodeUnknownSync(identity)(await response.json()).id;
  };
  return { bot, open, config, provider, request, create, cwd, workspace };
}

test("HTTP admission executes real tools, rejects conflicting retries and retains results across restart", async () => {
  const { bot, open, provider, request, create, cwd } = await fixture();
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "result.txt", content: "HTTP execution" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Written"),
  ]);
  const id = await create("create-once");
  expect(await create("create-once")).toBe(id);
  const response = await request(`/v1/threads/${id}/messages`, {
    prompt: "Write a file",
    requestId: "input-once",
  });
  expect(response.status).toBe(202);
  const accepted = Schema.decodeUnknownSync(admission)(await response.json());
  await expect
    .poll(async () => (await bot.core.operation(id, accepted.operationId)).status)
    .toBe("completed");
  expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("HTTP execution");
  const repeated = await request(`/v1/threads/${id}/messages`, {
    prompt: "Write a file",
    requestId: "input-once",
  });
  expect(repeated.status).toBe(202);
  expect(Schema.decodeUnknownSync(admission)(await repeated.json())).toEqual(accepted);
  const conflicting = await request(`/v1/threads/${id}/messages`, {
    prompt: "Different input",
    requestId: "input-once",
  });
  expect(conflicting.status).toBe(409);
  await bot.close();
  const restored = await open();
  const result = await restored.app.request(
    `/v1/threads/${id}/operations/${accepted.operationId}`,
    { headers: { authorization: "Bearer test-admin-token" } },
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    status: "completed",
    operationId: accepted.operationId,
  });
});

test("authentication and configured workspace boundaries reject input before execution", async () => {
  const { bot, request } = await fixture();
  expect((await bot.app.request("/v1/projects")).status).toBe(401);
  expect((await bot.app.request("/healthz")).status).toBe(200);
  expect(
    (await request("/v1/threads", { workspaceId: "outside", requestId: "outside" })).status,
  ).toBe(403);
  expect(
    (
      await request("/v1/threads", {
        workspaceId: "outside",
        requestId: "invalid",
        cwd: "/arbitrary",
      })
    ).status,
  ).toBe(400);
  expect(await bot.core.threads()).toEqual([]);
});

test("a checkout allows one writer and an unadmitted Busy request can be retried", async () => {
  const { bot, provider, request, create } = await fixture();
  const waiting = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  provider.setResponses([
    (_context, options) => {
      options?.signal?.addEventListener(
        "abort",
        () => waiting.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return waiting.promise;
    },
    fauxAssistantMessage("Second result"),
  ]);
  const first = await create("first");
  const second = await create("second");
  expect(
    (await request(`/v1/threads/${first}/messages`, { prompt: "Wait", requestId: "first-input" }))
      .status,
  ).toBe(202);
  expect(
    (
      await request(`/v1/threads/${second}/messages`, {
        prompt: "Continue",
        requestId: "second-input",
      })
    ).status,
  ).toBe(409);
  expect(await bot.core.operationByRequest(second, "http:messages:second-input")).toBeUndefined();
  waiting.resolve(fauxAssistantMessage("First result"));
  await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
  expect(
    (
      await request(`/v1/threads/${second}/messages`, {
        prompt: "Continue",
        requestId: "second-input",
      })
    ).status,
  ).toBe(202);
  await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
});

test("another process connection cannot write the same Bot data root", async () => {
  const { config } = await fixture();
  await expect(createBotApplication(config)).rejects.toThrow("already using this data root");
});

test("graceful restart preserves and automatically resumes accepted work", async () => {
  const { bot, open, provider, request, create } = await fixture();
  const entered = Promise.withResolvers<void>();
  provider.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        entered.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
      }),
  ]);
  const id = await create("restart-thread");
  const response = await request(`/v1/threads/${id}/messages`, {
    prompt: "Resume",
    requestId: "restart-input",
  });
  expect(response.status).toBe(202);
  const accepted = Schema.decodeUnknownSync(admission)(await response.json());
  await entered.promise;
  await bot.close();
  provider.setResponses([fauxAssistantMessage("After restart")]);
  const restored = await open();
  await expect
    .poll(async () => (await restored.core.operation(id, accepted.operationId)).status)
    .toBe("completed");
  const view = await restored.core.openThread(id);
  expect(view.snapshot.transcript.filter(({ message }) => message.role === "user")).toHaveLength(1);
});

test("a missing persisted checkout keeps maintenance HTTP and history available until explicit recovery", async () => {
  const { bot, open, provider, request, create, cwd, config } = await fixture();
  const entered = Promise.withResolvers<void>();
  provider.setResponses([
    (_context, options) =>
      new Promise((resolve) => {
        entered.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
      }),
  ]);
  const id = await create("unavailable-checkout");
  const admitted = await request(`/v1/threads/${id}/messages`, {
    prompt: "Recover when available",
    requestId: "checkout-input",
  });
  expect(admitted.status).toBe(202);
  const accepted = Schema.decodeUnknownSync(admission)(await admitted.json());
  await entered.promise;
  await bot.close();
  const offline = `${cwd}-offline`;
  await rename(cwd, offline);
  provider.setResponses([fauxAssistantMessage("Checkout restored")]);
  const restored = await open();
  const headers = { authorization: `Bearer ${config.adminToken}` };
  expect((await restored.app.request(`/v1/threads/${id}`, { headers })).status).toBe(200);
  expect(restored.controller.status().blocked[id]).toContain("工作区目录不可用");
  expect((await restored.core.operation(id, accepted.operationId)).status).toBe("paused");
  const unavailable = await restored.app.request(`/v1/threads/${id}/resume`, {
    method: "POST",
    headers,
  });
  expect(unavailable.status).toBe(409);
  expect(await unavailable.json()).toMatchObject({ error: { code: "WorkspaceUnavailable" } });
  await rename(offline, cwd);
  expect(
    (await restored.app.request(`/v1/threads/${id}/resume`, { method: "POST", headers })).status,
  ).toBe(202);
  await expect
    .poll(async () => (await restored.core.operation(id, accepted.operationId)).status)
    .toBe("completed");
  expect(
    (await restored.core.openThread(id)).snapshot.transcript.filter(
      ({ message }) => message.role === "user",
    ),
  ).toHaveLength(1);
});

test("disconnecting a real HTTP SSE connection releases observation without stopping work", async () => {
  const { bot, provider, create } = await fixture();
  const waiting = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  provider.setResponses([
    (_context, options) => {
      options?.signal?.addEventListener(
        "abort",
        () => waiting.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return waiting.promise;
    },
  ]);
  const id = await create("sse-thread");
  const listening = Promise.withResolvers<number>();
  const server = serve({ fetch: bot.app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) =>
    listening.resolve(port),
  );
  try {
    const base = `http://127.0.0.1:${await listening.promise}`;
    const headers = { authorization: "Bearer test-admin-token" };
    const response = await fetch(`${base}/v1/threads/${id}/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "sse-input", prompt: "Continue after disconnect" }),
    });
    expect(response.status).toBe(202);
    const accepted = Schema.decodeUnknownSync(admission)(await response.json());
    const abort = new AbortController();
    const stream = await fetch(`${base}/v1/threads/${id}/events`, {
      headers,
      signal: abort.signal,
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
    abort.abort();
    await reader.cancel().catch(() => {});
    expect((await bot.core.operation(id, accepted.operationId)).status).not.toBe("aborted");
    waiting.resolve(fauxAssistantMessage("Completed after disconnect"));
    await expect
      .poll(async () => (await bot.core.operation(id, accepted.operationId)).status)
      .toBe("completed");
  } finally {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("blocked recovery reserves a checkout until a maintainer stops its task", async () => {
  const { bot, open, provider, workspace } = await fixture();
  await bot.close();
  const entered = Promise.withResolvers<void>();
  const task = defineTask<{}, { phase: "wait" }, string>({
    name: "test.required-extension",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_task, runtime) => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        runtime.signal.throwIfAborted();
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const original = await open({ extensions: () => [{ name: "test-extension", tasks: [task] }] });
  const blocked = await original.core.createThread(workspace);
  await original.core.enqueueTask(blocked.id, task.definition.name, {}, "required-task");
  await entered.promise;
  await original.close();
  const restored = await open();
  expect(restored.controller.status().blocked[blocked.id]).toContain("task definitions");
  await expect(restored.controller.resume(blocked.id)).rejects.toMatchObject({
    code: "MissingTaskDefinitions",
  });
  const another = await restored.core.createThread(workspace);
  await expect(
    restored.controller.submit(another.id, "New work", "another-request"),
  ).rejects.toMatchObject({ code: "Busy" });
  await restored.controller.stop(blocked.id);
  provider.setResponses([fauxAssistantMessage("Now permitted")]);
  const admitted = await restored.controller.submit(another.id, "New work", "another-request");
  await expect
    .poll(async () => (await restored.core.operation(another.id, admitted.operationId)).status)
    .toBe("completed");
});
