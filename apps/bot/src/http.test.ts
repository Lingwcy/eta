import {
  LibrarySchema,
  OpenThreadSchema,
  OperationSchema,
} from "../../mobile/src/bot/contracts.ts";
import type { ProjectMetadata } from "@eta/core/shared/projects";
import type { BotLibrary } from "@eta/core/shared/bot";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  readdir,
  symlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DateTime, Schema } from "effect";
import {
  ScheduleSchema,
  ScheduleProposalSchema,
  ScheduleRequestSchema,
  ScheduleOccurrenceSchema,
} from "@eta/core/shared/schedules";
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

async function fixture(
  empty = false,
  defaultProvider?: string,
  allowedSandboxModes?: BotConfig["allowedSandboxModes"],
) {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-http-"));
  roots.push(root);
  const cwd = join(root, "workspaces", "workspace");
  await mkdir(empty ? join(root, "workspaces") : cwd, { recursive: true });
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
    ...(allowedSandboxModes ? { allowedSandboxModes } : {}),
    workspaceRoot: join(root, "workspaces"),
    projects: empty ? [] : [{ key: "test", rootPath: cwd }],
    runtime: { defaultThinkingLevel: "off", ...(defaultProvider ? { defaultProvider } : {}) },
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

test("an unknown approval reviewer model fails startup instead of silently using another", async () => {
  const { config } = await fixture();
  await expect(
    createBotApplication(
      {
        ...config,
        dataRoot: `${config.dataRoot}-reviewer`,
        runtime: {
          ...config.runtime,
          approvalReviewer: { mode: "auto", model: { provider: "bot-test", modelId: "missing" } },
        },
      },
      { models: createModels() },
    ),
  ).rejects.toThrow("Unknown approval reviewer model bot-test/missing");
});

test("a missing sandbox returns a conflict without admitting unchecked execution", async () => {
  const { bot, open, config, cwd } = await fixture();
  await bot.close();
  const unavailable = await open({ sandboxWorkerPath: join(cwd, "missing-worker.mjs") });
  const headers = {
    authorization: `Bearer ${config.adminToken}`,
    "content-type": "application/json",
  };
  const response = await unavailable.app.request("/v1/threads", {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspaceId: [...unavailable.workspaceProjects.keys()][0],
      requestId: "unavailable-thread",
    }),
  });
  expect(response.status).toBe(201);
  const { id } = Schema.decodeUnknownSync(identity)(await response.json());
  const rejected = await unavailable.app.request(`/v1/threads/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "Run", requestId: "unavailable-input" }),
  });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: { code: "SandboxUnavailable" } });
  expect(await unavailable.core.operationByRequest(id, "unavailable-input")).toBeUndefined();
  expect((await unavailable.core.openThread(id)).snapshot.sandbox).toMatchObject({
    mode: "workspace-write",
    available: false,
  });
});

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

test("HTTP exposes sandbox ceilings and scopes approvals to the owning thread", async () => {
  const { bot, provider, request, create, cwd } = await fixture(false, undefined, [
    "read-only",
    "workspace-write",
  ]);
  const id = await create("sandbox-thread");
  const other = await create("other-thread");
  expect((await request(`/v1/threads/${id}/sandbox`, { mode: "danger-full-access" })).status).toBe(
    400,
  );
  expect((await request(`/v1/threads/${id}/sandbox`, { mode: "read-only" })).status).toBe(200);
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "approved-via-http.txt", content: "approved" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const response = await request(`/v1/threads/${id}/messages`, {
    prompt: "Write",
    requestId: "sandbox-message",
  });
  const operation = Schema.decodeUnknownSync(admission)(await response.json());
  await expect
    .poll(async () => (await bot.core.openThread(id)).snapshot.approvals?.length, { timeout: 5000 })
    .toBe(1);
  const approval = (await bot.core.openThread(id)).snapshot.approvals![0]!;
  expect(
    (await request(`/v1/threads/${other}/approvals/${approval.id}`, { approved: true })).status,
  ).toBe(404);
  await expect(readFile(join(cwd, "approved-via-http.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (
      await request(`/v1/threads/${id}/approvals/${approval.id}`, {
        approved: true,
        reuse: "forever",
      })
    ).status,
  ).toBe(400);
  expect(
    (await request(`/v1/threads/${id}/approvals/${approval.id}`, { approved: true })).status,
  ).toBe(200);
  const status = await bot.app.request("/v1/status", {
    headers: { authorization: "Bearer test-admin-token" },
  });
  expect(await status.json()).toMatchObject({
    capabilities: expect.arrayContaining(["approval-review", "git-metadata"]),
  });
  await expect
    .poll(async () => (await bot.core.operation(id, operation.operationId)).status, {
      timeout: 5000,
    })
    .toBe("completed");
  expect(await readFile(join(cwd, "approved-via-http.txt"), "utf8")).toBe("approved");
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

test("Desktop HTTP catalog and management stay within configured projects", async () => {
  const { bot, request, create, cwd } = await fixture();
  const outside = join(cwd, "outside");
  await mkdir(outside);
  const hidden = await bot.core.registerProject(outside);
  const hiddenWorkspace = (await bot.core.workspaces(hidden.id))[0]!;
  const hiddenThread = await bot.core.createThread(hiddenWorkspace.id);
  const id = await create("desktop-thread");
  const library = (await (await request("/v1/library")).json()) as BotLibrary;
  expect(library.projects.map((project: { id: string }) => project.id)).not.toContain(hidden.id);
  expect(library.threads.map((thread: { id: string }) => thread.id)).toEqual([id]);
  expect((await bot.app.request("/v1/library")).status).toBe(401);
  expect(
    (
      await request(`/v1/threads/${hiddenThread.id}/metadata`, {
        action: "rename",
        title: "Hidden",
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(`/v1/threads/${id}/metadata`, { action: "move", projectId: hidden.id })).status,
  ).toBe(403);
  expect(
    (
      await request(`/v1/threads/${id}/configure`, {
        provider: "bot-test",
        modelId: "one",
        thinkingLevel: "off",
      })
    ).status,
  ).toBe(200);
  expect(
    (await request(`/v1/threads/${id}/metadata`, { action: "rename", title: "Remote support" }))
      .status,
  ).toBe(200);
  expect(
    (await request(`/v1/threads/${id}/metadata`, { action: "archive", archived: true })).status,
  ).toBe(200);
  expect(((await (await request("/v1/library")).json()) as BotLibrary).threads[0]).toMatchObject({
    title: "Remote support",
    archivedAt: expect.any(Number),
  });
  expect(
    (await request(`/v1/threads/${id}/metadata`, { action: "archive", archived: false })).status,
  ).toBe(200);
  expect((await request(`/v1/threads/${id}/metadata`, { action: "delete" })).status).toBe(200);
  expect(((await (await request("/v1/library")).json()) as BotLibrary).threads).toEqual([]);
});

test("an empty root has no default project; folders can be created, adopted and restored", async () => {
  const { bot, config, request, open } = await fixture(true);
  expect(await (await request("/v1/projects")).json()).toEqual([]);
  expect(await readdir(config.workspaceRoot)).toEqual([]);
  const input = { name: "客户反馈", requestId: "new-project" };
  const created = await request("/v1/projects", input);
  expect(created.status).toBe(201);
  const project = (await created.json()) as ProjectMetadata;
  expect(project.rootPath).toBe(await realpath(join(config.workspaceRoot, input.name)));
  expect(await (await request("/v1/projects", input)).json()).toEqual(project);
  expect((await request("/v1/projects", { ...input, name: "changed" })).status).toBe(409);
  const library = (await (await request("/v1/library")).json()) as BotLibrary;
  const workspace = library.workspaces.find((value) => value.projectId === project.id)!;
  const thread = await request("/v1/threads", {
    workspaceId: workspace.id,
    requestId: "new-thread",
  });
  expect(thread.status).toBe(201);
  const id = Schema.decodeUnknownSync(identity)(await thread.json()).id;
  await mkdir(join(config.workspaceRoot, "existing"));
  expect(await (await request("/v1/projects")).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "existing" })]),
  );
  await bot.close();
  const restored = await open();
  const response = await restored.app.request("/v1/library", {
    headers: { authorization: `Bearer ${config.adminToken}` },
  });
  const catalog = (await response.json()) as BotLibrary;
  expect(catalog.projects).toContainEqual(project);
  expect(catalog.threads).toEqual(
    expect.arrayContaining([expect.objectContaining({ id, workspaceId: workspace.id })]),
  );
});

test("root scope rejects traversal and escaping symlinks, including previously registered workspaces", async () => {
  const { request, config, cwd, create } = await fixture();
  for (const name of ["../escape", "/tmp/escape", "a/b", "a\\b", "..", ".", " hidden "]) {
    expect((await request("/v1/projects", { name, requestId: name })).status).toBe(400);
  }
  const outside = join(config.dataRoot, "outside");
  await mkdir(outside);
  await symlink(outside, join(config.workspaceRoot, "escape"));
  expect((await request("/v1/projects", { name: "escape", requestId: "escape" })).status).toBe(403);
  expect(await (await request("/v1/projects")).json()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "escape" })]),
  );
  const id = await create("scope-thread");
  await rename(cwd, `${cwd}-saved`);
  await symlink(outside, cwd);
  const library = (await (await request("/v1/library")).json()) as BotLibrary;
  expect(library.threads.some((thread) => thread.id === id)).toBe(false);
  expect((await request(`/v1/threads/${id}`)).status).toBe(403);
  expect(await readdir(outside)).toEqual([]);
});

test("credential import persists API keys and OAuth without exposing secrets in the library", async () => {
  const { bot, request, config } = await fixture(true);
  const credentials = {
    anthropic: { type: "api_key", key: "private-key" },
    "openai-codex": {
      type: "oauth",
      access: "private-access",
      refresh: "private-refresh",
      expires: 0,
      accountId: "account",
    },
  };
  expect(
    (
      await bot.app.request("/v1/credentials/import", {
        method: "POST",
        body: JSON.stringify({ credentials }),
      })
    ).status,
  ).toBe(401);
  expect(await (await request("/v1/credentials/import", { credentials })).json()).toEqual({
    imported: 2,
  });
  expect(
    (
      await request("/v1/credentials/import", {
        credentials: { anthropic: { type: "oauth", access: "secret" } },
      })
    ).status,
  ).toBe(400);
  const library = (await (await request("/v1/library")).json()) as BotLibrary;
  expect(library.credentials).toHaveLength(2);
  expect(JSON.stringify(library)).not.toMatch(
    /private-key|private-access|private-refresh|accountId/,
  );
  await bot.close();
  const restored = await createBotApplication(config);
  bots.push(restored);
  expect((await restored.core.models()).some((value) => value.provider === "anthropic")).toBe(true);
  const remove = await restored.app.request("/v1/credentials/remove", {
    method: "POST",
    headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ providerId: "anthropic" }),
  });
  expect(remove.status).toBe(200);
  expect((await restored.core.models()).some((value) => value.provider === "anthropic")).toBe(
    false,
  );
});

test("creation uses the requested model even when the Bot default provider is unavailable", async () => {
  const { request, workspace, bot, provider } = await fixture(false, "unavailable-default");
  expect(
    (await request("/v1/threads", { workspaceId: workspace, requestId: "default" })).status,
  ).toBe(503);
  expect(await bot.core.threads()).toEqual([]);
  const configuration = { provider: "bot-test", modelId: "one", thinkingLevel: "off" };
  const input = { workspaceId: workspace, requestId: "selected", configuration };
  const created = await request("/v1/threads", input);
  expect(created.status).toBe(201);
  const thread = Schema.decodeUnknownSync(identity)(await created.json());
  expect((await bot.core.openThread(thread.id)).snapshot.configuration.model).toEqual({
    provider: "bot-test",
    modelId: "one",
  });
  expect(
    Schema.decodeUnknownSync(identity)(await (await request("/v1/threads", input)).json()).id,
  ).toBe(thread.id);
  expect(
    (
      await request("/v1/threads", {
        ...input,
        configuration: { ...configuration, modelId: "different" },
      })
    ).status,
  ).toBe(409);
  provider.setResponses([fauxAssistantMessage("Selected model works")]);
  expect(
    (await request(`/v1/threads/${thread.id}/messages`, { prompt: "Hello", requestId: "hello" }))
      .status,
  ).toBe(202);
  await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
  expect(
    (await bot.core.openThread(thread.id)).snapshot.transcript.some(
      ({ message }) => message.role === "assistant",
    ),
  ).toBe(true);
});

test("worktrees are created inside the workspace root without becoming new projects", async () => {
  const { bot, request, cwd, workspace } = await fixture();
  const git = (...args: string[]) =>
    promisify(execFile)(
      "git",
      ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args],
      {
        cwd,
      },
    );
  await git("init", "-q", "-b", "main");
  await writeFile(join(cwd, "README.md"), "hello\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  const projectId = bot.workspaceProjects.get(workspace)!;
  const projectsBefore = await (await request("/v1/projects")).json();
  const created = await request(`/v1/projects/${projectId}/worktrees`, {
    baseWorkspaceId: workspace,
    branch: { kind: "new", name: "eta/bot-task" },
    requestId: "bot-worktree",
  });
  expect(created.status).toBe(201);
  const worktree = (await created.json()) as { workspaceId: string; path: string };
  expect(worktree.path.startsWith(join(await realpath(join(cwd, "..")), ".eta-worktrees"))).toBe(
    true,
  );
  expect(await (await request("/v1/projects")).json()).toEqual(projectsBefore);
  expect(bot.workspaceProjects.get(worktree.workspaceId)).toBe(projectId);
  expect(await (await request(`/v1/workspaces/${worktree.workspaceId}/git`)).json()).toMatchObject({
    status: "ready",
    linkedWorktree: true,
    head: { name: "eta/bot-task" },
  });
  expect(await (await request(`/v1/projects/${projectId}/worktrees`)).json()).toMatchObject([
    { workspaceId: worktree.workspaceId, status: "ready" },
  ]);
  expect(
    await (
      await request(`/v1/workspaces/${worktree.workspaceId}/remove`, { requestId: "rm" })
    ).json(),
  ).toMatchObject({ status: "removed" });
  expect((await request(`/v1/projects/not-a-project/worktrees`)).status).toBe(403);
});

test("GitHub HTTP queries enforce project ownership and reject caller-supplied repositories", async () => {
  const { bot, request } = await fixture();
  const projectId = [...bot.workspaceProjects.values()][0]!;
  expect(
    (await request("/v1/projects/outside/github", { kind: "issues", state: "open" })).status,
  ).toBe(403);
  expect((await request("/v1/projects/outside/github/identity")).status).toBe(403);
  expect(
    (
      await request(`/v1/projects/${projectId}/github`, {
        kind: "issues",
        state: "all",
        owner: "outside",
      })
    ).status,
  ).toBe(400);
  const result = await request(`/v1/projects/${projectId}/github`, {
    kind: "issues",
    state: "open",
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ status: "error", code: "unavailable" });
  expect(await (await request("/v1/status")).json()).toMatchObject({
    capabilities: expect.arrayContaining(["git", "worktree", "github"]),
  });
});

test("schedule HTTP CRUD persists idempotent receipts and manual runs without deleting its thread", async () => {
  const { bot, config, create, provider } = await fixture();
  const id = await create("scheduled-thread");
  await bot.core.renameThread(id, "Scheduled thread");
  const send = (path: string, method = "GET", body?: object) =>
    bot.app.request(path, {
      method,
      headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const at = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000;
  const input = {
    requestId: "schedule/create:opaque",
    name: "Review",
    prompt: "Original prompt",
    rule: { type: "once", at },
  };
  const response = await send(`/v1/threads/${id}/schedules`, "POST", input);
  expect(response.status).toBe(201);
  const created = Schema.decodeUnknownSync(ScheduleRequestSchema)(await response.json());
  expect(created.state).toBe("applied");
  expect(created.nextRunAt).toBe(at);
  expect(created.requestId).toBe(input.requestId);
  const scheduleId = created.scheduleId!;
  const replay = await send(`/v1/threads/${id}/schedules`, "POST", input);
  expect(await replay.json()).toEqual(created);
  expect(
    (await send(`/v1/threads/${id}/schedules`, "POST", { ...input, prompt: "Conflicting prompt" }))
      .status,
  ).toBe(400);
  expect(
    (
      await send(`/v1/threads/${id}/schedules`, "POST", {
        ...input,
        requestId: "empty-prompt",
        prompt: "   ",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(`/v1/threads/${id}/schedules`, "POST", {
        ...input,
        requestId: "empty-name",
        name: "   ",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(`/v1/threads/${id}/schedules`, "POST", {
        ...input,
        requestId: "invalid",
        rule: { type: "interval", anchorAt: 0, everyMs: 1 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send(`/v1/schedules/${scheduleId}`, "PATCH", {
        requestId: "edit",
        expectedRevision: 1,
        patch: { prompt: "Edited prompt" },
      })
    ).status,
  ).toBe(200);
  const listed = Schema.decodeUnknownSync(
    Schema.Struct({ revision: Schema.Number, schedules: Schema.Array(ScheduleSchema) }),
  )(await (await send(`/v1/schedules?threadId=${id}`)).json());
  expect(listed.schedules).toHaveLength(1);
  expect(listed.schedules[0].revision).toBe(2);
  expect(listed.schedules[0].prompt).toBe("Edited prompt");
  expect(
    (
      await send(`/v1/schedules/${scheduleId}/pause`, "POST", {
        requestId: "pause",
        expectedRevision: 2,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send(`/v1/schedules/${scheduleId}/resume`, "POST", {
        requestId: "stale",
        expectedRevision: 2,
      })
    ).status,
  ).toBe(409);
  provider.setResponses([fauxAssistantMessage("Manual scheduled work finished")]);
  const manualResponse = await send(`/v1/schedules/${scheduleId}/run`, "POST", {
    requestId: "manual",
    expectedRevision: 3,
  });
  expect(manualResponse.status).toBe(200);
  const manual = Schema.decodeUnknownSync(ScheduleRequestSchema)(await manualResponse.json());
  await expect
    .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.state, {
      timeout: 10000,
    })
    .toBe("succeeded");
  const runs = Schema.decodeUnknownSync(
    Schema.Struct({ runs: Schema.Array(ScheduleOccurrenceSchema) }),
  )(await (await send(`/v1/schedules/${scheduleId}/runs`)).json());
  expect(runs.runs).toHaveLength(1);
  expect(runs.runs[0].id).toBe(manual.occurrenceId);
  expect(runs.runs[0].prompt).toBe("Edited prompt");
  expect(
    (
      await send(`/v1/schedules/${scheduleId}/resume`, "POST", {
        requestId: "resume",
        expectedRevision: 3,
      })
    ).status,
  ).toBe(200);
  const deletion = { requestId: "delete/opaque:receipt", expectedRevision: 4 };
  const deleted = Schema.decodeUnknownSync(ScheduleRequestSchema)(
    await (await send(`/v1/schedules/${scheduleId}`, "DELETE", deletion)).json(),
  );
  expect(deleted.state).toBe("applied");
  expect(await (await send(`/v1/schedules/${scheduleId}`, "DELETE", deletion)).json()).toEqual(
    deleted,
  );
  expect(
    await (await send(`/v1/schedule-requests/${encodeURIComponent(deletion.requestId)}`)).json(),
  ).toEqual(deleted);
  expect((await bot.core.listSchedules()).length).toBe(0);
  expect((await bot.core.threads()).some((thread) => thread.id === id)).toBe(true);
  await bot.core.deleteThread(id);
  expect(
    await (await send(`/v1/schedule-requests/${encodeURIComponent(deletion.requestId)}`)).json(),
  ).toEqual(deleted);
}, 15000);

test("authenticated HTTP proposals stay inactive until an exact approval and decisions replay once", async () => {
  const { bot, request, create } = await fixture();
  const id = await create("proposal-thread");
  const input = {
    requestId: "propose",
    change: {
      action: "create",
      name: "Review",
      prompt: "Proposed work",
      rule: { type: "once", at: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000 },
    },
  };
  const proposedResponse = await request(`/v1/threads/${id}/schedule-proposals`, input);
  expect(proposedResponse.status).toBe(201);
  const proposed = Schema.decodeUnknownSync(ScheduleRequestSchema)(await proposedResponse.json());
  expect(await bot.core.listSchedules()).toEqual([]);
  const pending = Schema.decodeUnknownSync(
    Schema.Struct({ proposals: Schema.Array(ScheduleProposalSchema) }),
  )(await (await request("/v1/schedule-proposals?state=pending")).json()).proposals[0];
  expect(pending.id).toBe(proposed.proposalId);
  expect(pending.state).toBe("pending");
  expect(
    (
      await request(`/v1/schedule-proposals/${pending.id}/approve`, {
        requestId: "wrong",
        contentFingerprint: "wrong",
      })
    ).status,
  ).toBe(409);
  expect(await bot.core.listSchedules()).toEqual([]);
  const approval = { requestId: "approve", contentFingerprint: pending.contentFingerprint };
  const approvedResponse = await request(`/v1/schedule-proposals/${pending.id}/approve`, approval);
  expect(approvedResponse.status).toBe(200);
  const approved = Schema.decodeUnknownSync(ScheduleRequestSchema)(await approvedResponse.json());
  expect(
    await (await request(`/v1/schedule-proposals/${pending.id}/approve`, approval)).json(),
  ).toEqual(approved);
  const schedule = (await bot.core.listSchedules())[0];
  expect(schedule.id).toBe(approved.scheduleId);
  expect(schedule.nextRunAt).toBe(input.change.rule.at);
  const pause = Schema.decodeUnknownSync(ScheduleRequestSchema)(
    await (
      await request(`/v1/threads/${id}/schedule-proposals`, {
        requestId: "propose-pause",
        change: { action: "pause", scheduleId: schedule.id, expectedRevision: 1 },
      })
    ).json(),
  );
  const pauseProposal = (await bot.core.listScheduleProposals()).find(
    (proposal) => proposal.id === pause.proposalId,
  )!;
  expect(
    (
      await request(`/v1/schedule-proposals/${pauseProposal.id}/reject`, {
        requestId: "reject",
        contentFingerprint: pauseProposal.contentFingerprint,
      })
    ).status,
  ).toBe(200);
  expect((await bot.core.listSchedules())[0].state).toBe("active");
  expect(
    (await bot.core.listScheduleProposals()).find((proposal) => proposal.id === pauseProposal.id)
      ?.state,
  ).toBe("rejected");
  expect((await bot.app.request("/v1/schedule-proposals")).status).toBe(401);
});

test("schedule and proposal ID routes recheck project scope instead of trusting filtered lists", async () => {
  const { bot, open, config, cwd, create } = await fixture();
  const id = await create("scope-thread");
  const at = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000;
  const created = await bot.core.createSchedule({
    threadId: id,
    requestId: "scope-create",
    name: "Private schedule",
    prompt: "Private scope prompt",
    rule: { type: "once", at },
  });
  const proposed = await bot.core.proposeScheduleChange({
    threadId: id,
    requestId: "scope-propose",
    sourceIdentity: "root:scope",
    change: {
      action: "create",
      name: "Private proposal",
      prompt: "Private proposal prompt",
      rule: { type: "once", at },
    },
  });
  const proposal = (await bot.core.listScheduleProposals())[0];
  await bot.close();
  const outside = join(config.dataRoot, "..", "outside");
  await rename(cwd, outside);
  await symlink(outside, cwd, "dir");
  const restored = await open();
  const send = (path: string, method = "GET", body?: object) =>
    restored.app.request(path, {
      method,
      headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const schedules = Schema.decodeUnknownSync(
    Schema.Struct({ schedules: Schema.Array(ScheduleSchema) }),
  )(await (await send("/v1/schedules")).json());
  const proposals = Schema.decodeUnknownSync(
    Schema.Struct({ proposals: Schema.Array(ScheduleProposalSchema) }),
  )(await (await send("/v1/schedule-proposals")).json());
  expect(schedules.schedules).toEqual([]);
  expect(proposals.proposals).toEqual([]);
  const attempts: Array<[string, string, object?]> = [
    [`/v1/schedules/${created.scheduleId}/runs`, "GET"],
    [
      `/v1/schedules/${created.scheduleId}`,
      "PATCH",
      { requestId: "out-edit", expectedRevision: 1, patch: { prompt: "Changed" } },
    ],
    [
      `/v1/schedules/${created.scheduleId}/pause`,
      "POST",
      { requestId: "out-pause", expectedRevision: 1 },
    ],
    [
      `/v1/schedules/${created.scheduleId}/resume`,
      "POST",
      { requestId: "out-resume", expectedRevision: 1 },
    ],
    [
      `/v1/schedules/${created.scheduleId}/run`,
      "POST",
      { requestId: "out-run", expectedRevision: 1 },
    ],
    [
      `/v1/schedules/${created.scheduleId}`,
      "DELETE",
      { requestId: "out-delete", expectedRevision: 1 },
    ],
    [
      `/v1/schedule-proposals/${proposed.proposalId}/approve`,
      "POST",
      { requestId: "out-approve", contentFingerprint: proposal.contentFingerprint },
    ],
    [
      `/v1/schedule-proposals/${proposed.proposalId}/reject`,
      "POST",
      { requestId: "out-reject", contentFingerprint: proposal.contentFingerprint },
    ],
    ["/v1/schedule-requests/scope-create", "GET"],
    ["/v1/schedule-requests/scope-propose", "GET"],
    [
      `/v1/threads/${id}/schedules`,
      "POST",
      { requestId: "out-create", name: "Bad", prompt: "Bad", rule: { type: "once", at } },
    ],
    [
      `/v1/threads/${id}/schedule-proposals`,
      "POST",
      {
        requestId: "out-propose",
        change: { action: "create", name: "Bad", prompt: "Bad", rule: { type: "once", at } },
      },
    ],
  ];
  for (const [path, method, body] of attempts) {
    const response = await send(path, method, body);
    expect(response.status, path).toBe(403);
    expect(await response.text()).not.toContain("Private scope prompt");
  }
  expect((await restored.core.listSchedules())[0].revision).toBe(1);
  expect((await restored.core.listScheduleProposals())[0].state).toBe("pending");
  expect((await send("/v1/schedule-requests/missing")).status).toBe(404);
});

test("schedule SSE publishes a store revision and detaches when the client aborts", async () => {
  const { bot, config, create } = await fixture();
  const id = await create("events-thread");
  const abort = new AbortController();
  const response = await bot.app.request("/v1/schedules/events", {
    headers: { authorization: `Bearer ${config.adminToken}` },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("event: schedules");
    const before = (await bot.core.scheduleSnapshot()).revision;
    await bot.core.createSchedule({
      threadId: id,
      requestId: "sse-create",
      name: "Review",
      prompt: "Content stays out of revision events",
      rule: { type: "once", at: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 60_000 },
    });
    const next = decoder.decode((await reader.read()).value);
    expect(next).toContain(`"revision":${before + 1}`);
    expect(next).not.toContain("Content stays out");
    abort.abort();
    await reader.cancel();
    // A later write exercises the detached stream path without leaving a hanging subscription.
    const schedule = (await bot.core.listSchedules())[0];
    await bot.core.pauseSchedule({
      scheduleId: schedule.id,
      expectedRevision: 1,
      requestId: "after-abort",
    });
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
});

test("HTTP pending management preserves the active state until uncertain admission converges", async () => {
  const { bot, request, create } = await fixture();
  const id = await create("pending-management");
  await bot.core.stopScheduler();
  const { scheduleHostAdapter } = await import("@eta/core/service/schedules/host");
  let release!: (
    result: import("@eta/core/service/schedules/dispatcher").ScheduleAdmissionResult,
  ) => void;
  const admission = new Promise<
    import("@eta/core/service/schedules/dispatcher").ScheduleAdmissionResult
  >((resolve) => {
    release = resolve;
  });
  const adapter = scheduleHostAdapter(
    {
      submit: (id, prompt, requestId) => bot.controller.submit(id, prompt, requestId),
      operationByRequest: (id, requestId) => bot.core.operationByRequest(id, requestId),
      recovery: (id) => bot.core.recovery(id),
    },
    async (id) => {
      await bot.controller.authorize(id);
      return undefined;
    },
  );
  adapter.submit = async () => admission;
  try {
    await bot.core.startScheduler(adapter);
    const created = await bot.core.createSchedule({
      threadId: id,
      requestId: "pending-create",
      name: "Pending review",
      prompt: "Pending prompt",
      rule: { type: "once", at: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 100 },
    });
    const scheduleId = created.scheduleId!;
    await expect
      .poll(async () => (await bot.core.listScheduleRuns({ scheduleId }))[0]?.state, {
        timeout: 5000,
      })
      .toBe("dispatching");
    const pausedResponse = await request(`/v1/schedules/${scheduleId}/pause`, {
      expectedRevision: 1,
      requestId: "pending-pause",
    });
    expect(pausedResponse.status).toBe(202);
    const pending = Schema.decodeUnknownSync(ScheduleRequestSchema)(await pausedResponse.json());
    expect(pending.state).toBe("pending");
    const snapshot = Schema.decodeUnknownSync(
      Schema.Struct({
        schedules: Schema.Array(ScheduleSchema),
        requests: Schema.Array(ScheduleRequestSchema),
      }),
    )(await (await request(`/v1/schedules?threadId=${id}`)).json());
    expect(snapshot.schedules[0].state).toBe("active");
    expect(snapshot.requests[0].requestId).toBe("pending-pause");
    expect(await (await request("/v1/schedule-requests/pending-pause")).json()).toEqual(pending);
    release({ status: "blocked", reason: "busy" });
    await expect
      .poll(async () => (await bot.core.scheduleRequest({ requestId: "pending-pause" }))?.state, {
        timeout: 5000,
      })
      .toBe("applied");
    const applied = await bot.core.scheduleRequest({ requestId: "pending-pause" });
    expect(applied?.reason).toBeUndefined();
    expect(applied?.nextRunAt).toBeNull();
    expect((await bot.core.listSchedules())[0].state).toBe("paused");
    expect((await bot.core.scheduleSnapshot()).requests).toEqual([]);
    expect(
      (await bot.core.openThread(id)).snapshot.transcript.filter(
        (entry) => entry.message.role === "user",
      ),
    ).toHaveLength(0);
  } finally {
    release({ status: "blocked", reason: "cleanup" });
  }
}, 15000);

test("real Bot HTTP responses remain compatible with the mobile consumer contracts", async () => {
  const { provider, request, create } = await fixture();
  const id = await create("mobile-contract");
  const libraryResponse = await request("/v1/library");
  expect(libraryResponse.status).toBe(200);
  const library = LibrarySchema.parse(await libraryResponse.json());
  expect(library.threads.map((thread) => thread.id)).toContain(id);
  expect(library.models.length).toBeGreaterThan(0);
  const initialResponse = await request(`/v1/threads/${id}`);
  expect(initialResponse.status).toBe(200);
  const initial = OpenThreadSchema.parse(await initialResponse.json());
  expect(initial.id).toBe(id);
  expect(initial.snapshot.transcript).toEqual([]);
  provider.setResponses([fauxAssistantMessage("Mobile contract proof")]);
  const response = await request(`/v1/threads/${id}/messages`, {
    prompt: "Verify mobile contract",
    requestId: "mobile-contract-run",
  });
  expect(response.status).toBe(202);
  const accepted = Schema.decodeUnknownSync(admission)(await response.json());
  await expect
    .poll(
      async () => {
        const result = await request(`/v1/threads/${id}/operations/${accepted.operationId}`);
        expect(result.status).toBe(200);
        return OperationSchema.parse(await result.json()).status;
      },
      { timeout: 10_000 },
    )
    .toBe("completed");
  const completedResponse = await request(`/v1/threads/${id}`);
  expect(completedResponse.status).toBe(200);
  const completed = OpenThreadSchema.parse(await completedResponse.json());
  expect(completed.snapshot.lastResult?.status).toBe("completed");
  expect(completed.snapshot.transcript.some((entry) => entry.message.role === "user")).toBe(true);
  expect(JSON.stringify(completed.snapshot.transcript)).toContain("Mobile contract proof");
});

test("default deployment advertises full access and permits switching both ways", async () => {
  const { bot, request, create } = await fixture();
  const library = await request("/v1/library");
  expect(library.status).toBe(200);
  expect(await library.json()).toMatchObject({
    allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  });
  const id = await create("full-access-thread");
  expect((await bot.core.openThread(id)).snapshot.sandbox?.mode).toBe("workspace-write");
  for (const mode of ["danger-full-access", "read-only", "workspace-write"]) {
    expect((await request(`/v1/threads/${id}/sandbox`, { mode })).status).toBe(200);
    expect((await bot.core.openThread(id)).snapshot.sandbox?.mode).toBe(mode);
  }
});
