import {
  LibrarySchema,
  OpenThreadSchema,
  OperationSchema,
} from "../../mobile/src/bot/contracts.ts";
import { MobileStore } from "../../mobile/src/bot/store.ts";
import { BotClient } from "../../mobile/src/bot/client.ts";
import { memoryStorage } from "../../mobile/src/bot/fixtures.test-support.ts";
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
import { dirname, join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { DateTime, Effect, Schema } from "effect";
import {
  ScheduleSchema,
  ScheduleProposalSchema,
  ScheduleRequestSchema,
  ScheduleOccurrenceSchema,
} from "@eta/core/shared/schedules";
import { serve } from "@hono/node-server";
import { defineTask } from "@eta/agent";
import { createCore, type CoreEnvironment } from "@eta/core";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { BotController } from "./controller.ts";
import { BotProjects } from "./projects.ts";
import { BotStore } from "./store.ts";
import { createBotApplication } from "./application.ts";
import type { BotApplication } from "./application.ts";
import type { BotConfig } from "./config.ts";
import type { SnapshotResponse } from "@eta/core/agent/protocol";
import type { BotLog } from "./log.ts";

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
  initialEnvironment?: Partial<CoreEnvironment>,
  log?: BotLog,
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
    runtime: {
      agentMode: "standard" as const,
      defaultThinkingLevel: "off",
      ...(defaultProvider ? { defaultProvider } : {}),
    },
  };
  const open = async (environment?: Partial<CoreEnvironment>) => {
    const bot = await createBotApplication(config, {
      models,
      log,
      ...(environment ? { environment } : {}),
    });
    bots.push(bot);
    return bot;
  };
  const bot = await open(initialEnvironment);
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
  return { bot, open, config, provider, models, request, create, cwd, workspace };
}

test.each(["thread", "git"] as const)(
  "a stalled %s read reports its backend phase without changing the HTTP result",
  async (kind) => {
    const log = vi.fn<BotLog>();
    const { bot, request, create, workspace } = await fixture(
      false,
      undefined,
      undefined,
      undefined,
      log,
    );
    const id = await create("slow-read");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalOpen = bot.core.openThread;
    const originalGit = bot.core.gitRepository;
    const held =
      kind === "thread"
        ? vi.spyOn(bot.core, "openThread").mockImplementation(async (...args) => {
            entered.resolve();
            await release.promise;
            return originalOpen(...args);
          })
        : vi.spyOn(bot.core, "gitRepository").mockImplementation(async (...args) => {
            entered.resolve();
            await release.promise;
            return originalGit(...args);
          });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = request(
      kind === "thread" ? `/v1/threads/${id}` : `/v1/workspaces/${workspace}/git`,
    );
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5000);
      const pending = log.mock.calls
        .map(([event]) => event)
        .find((event) => event.event === "http.slow");
      expect(pending).toMatchObject({
        operation: kind === "thread" ? "thread.read" : "workspace.git",
        phase: kind === "thread" ? "open" : "git",
        outcome: "pending",
      });
      release.resolve();
      expect((await reading).status).toBe(200);
      expect(
        log.mock.calls.map(([event]) => event).filter((event) => event.event === "http.slow"),
      ).toMatchObject([
        { outcome: "pending", request: pending!.request },
        { outcome: "completed", request: pending!.request, phase: "encode" },
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("test-admin-token");
    } finally {
      release.resolve();
      vi.useRealTimers();
      await reading;
      held.mockRestore();
    }
  },
);

test("projectless HTTP threads remain visible, accept messages and replay on the Bot", async () => {
  const { bot, request, provider, config } = await fixture(true);
  const body = { workspaceId: null, requestId: "temporary-http" };
  const response = await request("/v1/threads", body);
  expect(response.status).toBe(201);
  const created = Schema.decodeUnknownSync(
    Schema.Struct({ id: Schema.String, workspaceId: Schema.String }),
  )(await response.json());
  const replay = await request("/v1/threads", body);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ id: created.id, workspaceId: created.workspaceId });
  expect(bot.workspaceProjects.has(created.workspaceId)).toBe(true);
  const library = await request("/v1/library");
  expect(library.status).toBe(200);
  const parsed = LibrarySchema.parse(await library.json());
  expect(parsed.projects).toEqual([]);
  expect(parsed.workspaces).toMatchObject([{ kind: "temporary", projectId: null }]);
  expect(parsed.threads).toMatchObject([{ id: created.id }]);
  provider.setResponses([fauxAssistantMessage("Hello from the Bot")]);
  const sent = await request(`/v1/threads/${created.id}/messages`, {
    requestId: "temporary-message",
    prompt: "Hello",
  });
  expect(sent.status).toBe(202);
  const operation = Schema.decodeUnknownSync(admission)(await sent.json());
  await expect
    .poll(async () => (await bot.core.operation(created.id, operation.operationId)).status, {
      timeout: 10000,
    })
    .toBe("completed");
  await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
  expect((await request(`/v1/threads/${created.id}`)).status).toBe(200);
  const cwd = parsed.workspaces[0]!.cwd;
  expect(dirname(cwd)).toBe(await realpath(join(config.workspaceRoot, ".eta-temporary")));
  await rename(cwd, `${cwd}-retained`);
  try {
    await symlink(config.workspaceRoot, cwd, "dir");
    expect((await request(`/v1/threads/${created.id}`)).status).toBe(403);
    expect(bot.workspaceProjects.has(created.workspaceId)).toBe(false);
  } finally {
    await rm(cwd, { force: true });
    await rename(`${cwd}-retained`, cwd);
  }
  expect((await request(`/v1/threads/${created.id}`)).status).toBe(200);
  await rename(cwd, `${cwd}-retained`);
  try {
    expect((await request(`/v1/threads/${created.id}`)).status).toBe(200);
    const unavailable = await request(`/v1/threads/${created.id}/messages`, {
      requestId: "missing-temporary-message",
      prompt: "Continue",
    });
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: "WorkspaceUnavailable" } });
  } finally {
    await rename(`${cwd}-retained`, cwd);
  }
});

test.each([false, true])(
  "Mobile new chat cannot silently reuse a temporary directory (newThread=%s)",
  async (startNew) => {
    const { bot, request, provider, config } = await fixture(true);
    const firstResponse = await request("/v1/threads", {
      workspaceId: null,
      requestId: "first-temporary",
    });
    expect(firstResponse.status).toBe(201);
    const first = OpenThreadSchema.parse(await firstResponse.json());
    const workspace = (await bot.core.workspaces()).find(
      (value) => value.id === first.thread.workspaceId,
    )!;
    await writeFile(join(workspace.cwd, "private.txt"), "First chat files");
    let id = 0;
    const store = new MobileStore(
      memoryStorage().storage,
      (connection) =>
        new BotClient(connection, async (input, init) => bot.app.request(new Request(input, init))),
      () => "mobile-" + ++id,
    );
    try {
      await store.connect({ url: "http://bot", token: config.adminToken });
      if (startNew) store.newThread();
      store.setDraft("A separate new chat");
      provider.setResponses([fauxAssistantMessage("Acknowledged")]);
      let failure: unknown;
      try {
        await store.send();
      } catch (error) {
        failure = error;
      }
      const threads = await bot.core.threads();
      const extra = threads.find((value) => value.id !== first.id);
      const target = extra
        ? (await bot.core.workspaces()).find((value) => value.id === extra.workspaceId)
        : undefined;
      expect({
        failure: failure instanceof Error ? failure.message : undefined,
        threads: threads.map((value) => ({ id: value.id, workspaceId: value.workspaceId })),
        reusedFile: target ? await readFile(join(target.cwd, "private.txt"), "utf8") : undefined,
      }).toEqual({
        failure: expect.stringContaining("选择项目"),
        threads: [{ id: first.id, workspaceId: workspace.id }],
        reusedFile: undefined,
      });
      await store.open(first.id);
      store.setDraft("Continue the original chat");
      await store.send();
      await expect
        .poll(() => bot.controller.status().activeThreads, { timeout: 10_000 })
        .toEqual([]);
      expect(store.getSnapshot().threadId).toBe(first.id);
      expect(await bot.core.threads()).toHaveLength(1);
      expect(await readFile(join(workspace.cwd, "private.txt"), "utf8")).toBe("First chat files");
    } finally {
      store.dispose();
    }
  },
  30_000,
);

test("Mobile can select a project for a new chat after viewing temporary history", async () => {
  const { bot, request, provider, config, workspace: projectWorkspace, cwd } = await fixture();
  const response = await request("/v1/threads", {
    workspaceId: null,
    requestId: "temporary-before-project",
  });
  expect(response.status).toBe(201);
  const first = OpenThreadSchema.parse(await response.json());
  const temporary = (await bot.core.workspaces()).find(
    (value) => value.id === first.thread.workspaceId,
  )!;
  await writeFile(join(temporary.cwd, "private.txt"), "First chat files");
  let id = 0;
  const store = new MobileStore(
    memoryStorage().storage,
    (connection) =>
      new BotClient(connection, async (input, init) => bot.app.request(new Request(input, init))),
    () => "mobile-" + ++id,
  );
  try {
    await store.connect({ url: "http://bot", token: config.adminToken });
    await store.open(first.id);
    store.newThread(projectWorkspace);
    store.setDraft("A project chat");
    provider.setResponses([fauxAssistantMessage("Acknowledged")]);
    await store.send();
    await expect.poll(() => bot.controller.status().activeThreads, { timeout: 10_000 }).toEqual([]);
    expect(store.getSnapshot().thread?.thread.workspaceId).toBe(projectWorkspace);
    expect(store.getSnapshot().threadId).not.toBe(first.id);
    expect(await bot.core.threads()).toHaveLength(2);
    await expect(readFile(join(cwd, "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(temporary.cwd, "private.txt"), "utf8")).toBe("First chat files");
  } finally {
    store.dispose();
  }
}, 30_000);

test("status and credential management do not scan projects; catalog requests still do", async () => {
  const { bot, request } = await fixture(true);
  await bot.core.stopScheduler();
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  try {
    for (let i = 0; i < 2; i++) {
      const status = await request("/v1/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        activeThreads: [],
        capabilities: expect.arrayContaining(["schedules"]),
      });
    }
    const imported = await request("/v1/credentials/import", {
      credentials: { anthropic: { type: "api_key", key: "admin-test-secret" } },
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({ imported: 1 });
    const removed = await request("/v1/credentials/remove", { providerId: "anthropic" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(refresh).not.toHaveBeenCalled();
    const catalog = await request("/v1/library");
    expect(catalog.status).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await catalog.json()).toMatchObject({ credentials: [] });
  } finally {
    refresh.mockRestore();
  }
});

test("status stays responsive while a catalog scan is held", async () => {
  const { bot, request } = await fixture(true);
  await bot.core.stopScheduler();
  let entered = false;
  const release = Promise.withResolvers<void>();
  const projects = bot.core.projects;
  const read = vi.spyOn(bot.core, "projects").mockImplementationOnce(async () => {
    entered = true;
    await release.promise;
    return projects();
  });
  const catalog = request("/v1/library");
  let status: Promise<Response> | undefined;
  try {
    await expect.poll(() => entered).toBe(true);
    let received: Response | undefined;
    status = Promise.resolve(request("/v1/status")).then((value) => {
      received = value;
      return value;
    });
    await expect.poll(() => received?.status).toBe(200);
  } finally {
    release.resolve();
    await catalog;
    await status;
    read.mockRestore();
  }
});

test("unavailable project discovery does not block administration or its request guards", async () => {
  const { bot, request, config } = await fixture(true);
  await bot.core.stopScheduler();
  const saved = config.workspaceRoot + "-saved";
  await rename(config.workspaceRoot, saved);
  await writeFile(config.workspaceRoot, "not a directory");
  try {
    expect((await request("/v1/status")).status).toBe(200);
    expect((await bot.app.request("/v1/status")).status).toBe(401);
    for (const path of ["/v1/credentials/import", "/v1/credentials/remove"]) {
      expect((await bot.app.request(path, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await request(path, {})).status).toBe(400);
      expect(
        (
          await bot.app.request(path, {
            method: "POST",
            headers: {
              authorization: "Bearer " + config.adminToken,
              "content-type": "application/json",
              "content-length": String(48 * 1024 * 1024 + 1),
            },
            body: "{}",
          })
        ).status,
      ).toBe(413);
    }
    expect(
      (
        await request("/v1/credentials/import", {
          credentials: { anthropic: { type: "api_key", key: "admin-test-secret" } },
        })
      ).status,
    ).toBe(200);
    expect((await request("/v1/credentials/remove", { providerId: "anthropic" })).status).toBe(200);
    // Scoped routes must still fail closed rather than treating an old catalog as fresh authorization.
    expect((await request("/v1/library")).status).toBe(500);
  } finally {
    await rm(config.workspaceRoot, { force: true });
    await rename(saved, config.workspaceRoot);
  }
  expect((await request("/v1/library")).status).toBe(200);
});

test("administrative routes still reject requests after shutdown", async () => {
  const { bot, request } = await fixture(true);
  await bot.close();
  expect((await request("/v1/status")).status).toBe(503);
  expect((await request("/v1/credentials/import", { credentials: {} })).status).toBe(503);
  expect((await request("/v1/credentials/remove", { providerId: "anthropic" })).status).toBe(503);
});
test.each(["compact", "unload-skill"])(
  "thread %s needs the target scope, not unrelated project discovery",
  async (kind) => {
    const { bot, config, create } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("maintenance-discovery-" + kind);
    const headers = {
      authorization: "Bearer " + config.adminToken,
      "content-type": "application/json",
    };
    if (kind === "compact") {
      // Compaction runs Core work; full access keeps the backend out of this assertion.
      const sandbox = await bot.app.request("/v1/threads/" + id + "/sandbox", {
        method: "POST",
        headers,
        body: JSON.stringify({ mode: "danger-full-access" }),
      });
      expect(sandbox.status).toBe(200);
    }
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    try {
      const response = await bot.app.request("/v1/threads/" + id + "/" + kind, {
        method: "POST",
        headers,
        ...(kind === "unload-skill" ? { body: JSON.stringify({ name: "missing-skill" }) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  },
);
test.each(["configure", "sandbox"])(
  "thread %s needs the target scope, not unrelated project discovery",
  async (kind) => {
    const { bot, config, create } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("admin-discovery-" + kind);
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    try {
      const response = await bot.app.request("/v1/threads/" + id + "/" + kind, {
        method: "POST",
        headers: {
          authorization: "Bearer " + config.adminToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          kind === "configure"
            ? { provider: "bot-test", modelId: "one", thinkingLevel: "off" }
            : { mode: "read-only" },
        ),
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  },
);
test.each(["stop", "resume"])(
  "thread %s needs the target scope, not unrelated project discovery",
  async (kind) => {
    const { bot, config, create } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("cancel-discovery-" + kind);
    const headers = { authorization: "Bearer " + config.adminToken };
    if (kind === "resume") {
      const stopped = await bot.app.request("/v1/threads/" + id + "/stop", {
        method: "POST",
        headers,
      });
      expect(stopped.status).toBe(200);
    }
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    try {
      const response = await bot.app.request("/v1/threads/" + id + "/" + kind, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(kind === "stop" ? 200 : 202);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  },
);

test.each(["history", "operation", "events", "head"])(
  "ordinary thread %s reads leave unrelated project discovery to the catalog",
  async (kind) => {
    const { bot, provider, request, create, config } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("read-discovery-" + kind);
    provider.setResponses([fauxAssistantMessage("Stored answer")]);
    const accepted = await bot.core.submit(id, "Stored prompt", "read-proof");
    await expect
      .poll(async () => (await bot.core.operation(id, accepted.operationId)).status)
      .toBe("completed");
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const registration = vi.spyOn(bot.core, "registerProject");
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const suffix =
        kind === "operation"
          ? "/operations/" + accepted.operationId
          : kind === "events"
            ? "/events"
            : "";
      const response = await bot.app.request("/v1/threads/" + id + suffix, {
        method: kind === "head" ? "HEAD" : "GET",
        headers: { authorization: "Bearer " + config.adminToken },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
      });
      expect(response.status).toBe(200);
      if (kind === "events") {
        reader = response.body!.getReader();
        const initial = new TextDecoder().decode((await reader.read()).value);
        expect(initial).toContain("event: snapshot");
        expect(initial).toContain("Stored answer");
        abort.abort();
        await reader.cancel();
      } else if (kind === "head") {
        expect(await response.text()).toBe("");
      } else if (kind === "operation") {
        expect(await response.json()).toMatchObject({
          operationId: accepted.operationId,
          status: "completed",
        });
      } else {
        const history = await response.text();
        expect(history).toContain("Stored prompt");
        expect(history).toContain("Stored answer");
      }
      expect(registration).not.toHaveBeenCalled();
      expect(await bot.core.projects()).toHaveLength(1);
      expect(refresh).not.toHaveBeenCalled();
      expect((await request("/v1/library")).status).toBe(200);
      expect(await bot.core.projects()).toHaveLength(2);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
      await reader?.cancel().catch(() => {});
      registration.mockRestore();
      refresh.mockRestore();
    }
  },
);

test.each(["history", "operation", "events", "head"])(
  "a previously readable thread %s rechecks scope after a checkout escapes",
  async (kind) => {
    const { bot, provider, create, config, cwd, workspace } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("read-revocation-" + kind);
    let suffix = kind === "events" ? "/events" : "";
    if (kind === "operation") {
      provider.setResponses([fauxAssistantMessage("Completed")]);
      const receipt = await bot.core.submit(id, "Before escape", "read-revocation");
      await expect
        .poll(async () => (await bot.core.operation(id, receipt.operationId)).status)
        .toBe("completed");
      suffix = "/operations/" + receipt.operationId;
    }
    const path = "/v1/threads/" + id + suffix;
    const abort = new AbortController();
    const options = {
      method: kind === "head" ? "HEAD" : "GET",
      headers: { authorization: "Bearer " + config.adminToken },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3000)]),
    };
    const healthy = await bot.app.request(path, options);
    expect(healthy.status).toBe(200);
    if (kind === "events") {
      const reader = healthy.body!.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: snapshot");
      } finally {
        abort.abort();
        await reader.cancel().catch(() => {});
      }
    } else await healthy.arrayBuffer();
    const outside = join(config.dataRoot, "outside");
    await rename(cwd, outside);
    await symlink(outside, cwd, "dir");
    expect(bot.workspaceProjects.has(workspace)).toBe(true);
    const opening = vi.spyOn(bot.core, "openThread");
    const operation = vi.spyOn(bot.core, "operation");
    const observing = vi.spyOn(bot.core, "subscribe");
    try {
      // A reconnect is a new request, not a continuation authorized by the healthy stream.
      const denied = await bot.app.request(path, {
        method: options.method,
        headers: options.headers,
      });
      expect(denied.status).toBe(403);
      if (kind !== "head")
        expect(await denied.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
      expect(bot.workspaceProjects.has(workspace)).toBe(false);
      expect(opening).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(observing).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      opening.mockRestore();
      operation.mockRestore();
      observing.mockRestore();
    }
  },
);

test("targeted thread reads retain authentication and shutdown guards", async () => {
  const { bot, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("read-guards");
  const paths = [
    "/v1/threads/" + id,
    "/v1/threads/" + id + "/operations/missing",
    "/v1/threads/" + id + "/events",
  ];
  const metadata = vi.spyOn(bot.core, "threadMetadata");
  try {
    for (const path of paths) expect((await bot.app.request(path)).status).toBe(401);
    expect((await bot.app.request(paths[0]!, { method: "HEAD" })).status).toBe(401);
    expect(metadata).not.toHaveBeenCalled();
    await bot.close();
    const headers = { authorization: "Bearer " + config.adminToken };
    for (const path of paths) expect((await bot.app.request(path, { headers })).status).toBe(503);
    expect((await bot.app.request(paths[0]!, { method: "HEAD", headers })).status).toBe(503);
    expect(metadata).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
  }
});

test.each(["rename", "archive", "delete"] as const)(
  "metadata %s leaves unrelated discovery to catalog reads",
  async (action) => {
    const { bot, request, create, config } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("metadata-discovery-" + action);
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const registration = vi.spyOn(bot.core, "registerProject");
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    try {
      const body =
        action === "rename"
          ? { action, title: "Manual title" }
          : action === "archive"
            ? { action, archived: true }
            : { action };
      const response = await request("/v1/threads/" + id + "/metadata", body);
      expect(response.status).toBe(200);
      if (action === "delete") {
        expect(await response.json()).toEqual({ deleted: true });
        expect((await bot.core.threads(undefined, true)).some((thread) => thread.id === id)).toBe(
          false,
        );
      } else if (action === "rename") {
        expect(await bot.core.threadMetadata(id)).toMatchObject({
          title: "Manual title",
          titleSource: "manual",
        });
      } else {
        expect((await bot.core.threadMetadata(id)).archivedAt).toBeTypeOf("number");
        expect(
          (await request("/v1/threads/" + id + "/metadata", { action: "archive", archived: false }))
            .status,
        ).toBe(200);
        expect((await bot.core.threadMetadata(id)).archivedAt).toBeUndefined();
      }
      expect(registration).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(await bot.core.projects()).toHaveLength(1);
      expect((await request("/v1/library")).status).toBe(200);
      expect(await bot.core.projects()).toHaveLength(2);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      registration.mockRestore();
      refresh.mockRestore();
    }
  },
);

test.each(["rename", "archive", "delete"] as const)(
  "metadata %s rejects an escaped source before changing Core state",
  async (action) => {
    const { bot, request, create, config, cwd, workspace } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("metadata-escape-" + action);
    await rename(cwd, join(config.dataRoot, "outside"));
    await symlink(join(config.dataRoot, "outside"), cwd, "dir");
    expect(bot.workspaceProjects.has(workspace)).toBe(true);
    const renameThread = vi.spyOn(bot.core, "renameThread");
    const archive = vi.spyOn(bot.core, "archiveThread");
    const remove = vi.spyOn(bot.core, "deleteThread");
    try {
      const body =
        action === "rename"
          ? { action, title: "No" }
          : action === "archive"
            ? { action, archived: true }
            : { action };
      const response = await request("/v1/threads/" + id + "/metadata", body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
      expect(bot.workspaceProjects.has(workspace)).toBe(false);
      expect(renameThread).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect((await bot.core.threadMetadata(id)).archivedAt).toBeUndefined();
    } finally {
      renameThread.mockRestore();
      archive.mockRestore();
      remove.mockRestore();
    }
  },
);

test("metadata moves revalidate a formerly visible destination", async () => {
  const { bot, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("move-destination");
  const path = join(config.workspaceRoot, "destination");
  await mkdir(path);
  const destination = await bot.core.registerProject(path);
  expect((await request("/v1/library")).status).toBe(200);
  expect([...bot.workspaceProjects.values()]).toContain(destination.id);
  const before = await bot.core.threadMetadata(id);
  const outside = join(config.dataRoot, "destination-outside");
  await rename(path, outside);
  await symlink(outside, path, "dir");
  const moving = vi.spyOn(bot.core, "moveThread");
  try {
    const response = await request("/v1/threads/" + id + "/metadata", {
      action: "move",
      projectId: destination.id,
    });
    expect(response.status).toBe(403);
    expect([...bot.workspaceProjects.values()]).not.toContain(destination.id);
    expect(moving).not.toHaveBeenCalled();
    expect((await bot.core.threadMetadata(id)).projectId).toBe(before.projectId);
  } finally {
    moving.mockRestore();
  }
});

test("metadata moves discover valid destinations and support clearing the display group", async () => {
  const { bot, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("move-valid");
  const path = join(config.workspaceRoot, "destination");
  await mkdir(path);
  const destination = await bot.core.registerProject(path);
  expect([...bot.workspaceProjects.values()]).not.toContain(destination.id);
  expect(
    (
      await request("/v1/threads/" + id + "/metadata", {
        action: "move",
        projectId: destination.id,
      })
    ).status,
  ).toBe(200);
  expect((await bot.core.threadMetadata(id)).projectId).toBe(destination.id);
  expect(
    (await request("/v1/threads/" + id + "/metadata", { action: "move", projectId: null })).status,
  ).toBe(200);
  expect((await bot.core.threadMetadata(id)).projectId).toBeNull();
});

test("metadata moves recheck source ownership after the destination refresh", async () => {
  const { bot, request, create, config, cwd, workspace } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("move-source-revocation");
  const original = BotProjects.prototype.refresh;
  const release = Promise.withResolvers<void>();
  let entered = false;
  const refresh = vi.spyOn(BotProjects.prototype, "refresh").mockImplementationOnce(async function (
    this: BotProjects,
    ...args
  ) {
    await original.apply(this, args);
    entered = true;
    await release.promise;
  });
  const moving = vi.spyOn(bot.core, "moveThread");
  const pending = request("/v1/threads/" + id + "/metadata", { action: "move", projectId: null });
  try {
    await expect.poll(() => entered).toBe(true);
    await rename(cwd, join(config.dataRoot, "outside"));
    await symlink(join(config.dataRoot, "outside"), cwd, "dir");
    // A later real scope publication revokes the source while the earlier refresh reply is held.
    expect((await request("/v1/library")).status).toBe(200);
    expect(bot.workspaceProjects.has(workspace)).toBe(false);
    release.resolve();
    expect((await pending).status).toBe(403);
    expect(moving).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.resolve(pending).catch(() => {});
    refresh.mockRestore();
    moving.mockRestore();
  }
});

test("targeted metadata keeps authentication, body limits, input and shutdown guards", async () => {
  const { bot, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("metadata-guards");
  const path = "/v1/threads/" + id + "/metadata";
  const metadata = vi.spyOn(bot.core, "threadMetadata");
  try {
    expect((await bot.app.request(path, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await bot.app.request(path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + config.adminToken,
            "content-length": String(48 * 1024 * 1024 + 1),
          },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    expect(metadata).not.toHaveBeenCalled();
    expect((await request(path, { action: "rename" })).status).toBe(400);
    await bot.close();
    metadata.mockClear();
    expect((await request(path, { action: "delete" })).status).toBe(503);
    expect(metadata).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
  }
});

test("subagent listing leaves unrelated discovery to the catalog", async () => {
  const { bot, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("subagent-list-scope");
  await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
  const registration = vi.spyOn(bot.core, "registerProject");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  try {
    const response = await request("/v1/threads/" + id + "/subagent", {
      command: { action: "list" },
      requestId: "list",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(registration).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await bot.core.projects()).toHaveLength(1);
    expect((await request("/v1/library")).status).toBe(200);
    expect(await bot.core.projects()).toHaveLength(2);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    registration.mockRestore();
    refresh.mockRestore();
  }
});

test("subagent spawn replay and steering do not discover unrelated projects", async () => {
  const { bot, provider, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("subagent-writer-scope");
  await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
  provider.setResponses(
    Array.from({ length: 15 }, () => fauxAssistantMessage("First delegated result")),
  );
  const registration = vi.spyOn(bot.core, "registerProject");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  const children = Schema.Array(Schema.Struct({ path: Schema.String }));
  const path = "/v1/threads/" + id + "/subagent";
  let child: SnapshotResponse | undefined;
  let childError: string | undefined;
  let closeChild: (() => void) | undefined;
  try {
    const body = {
      command: { action: "spawn", name: "worker", message: "Work independently", wait: false },
      requestId: "spawn-once",
    };
    const spawned = await request(path, body);
    expect(spawned.status).toBe(200);
    const first = Schema.decodeUnknownSync(children)(await spawned.json());
    expect(first).toHaveLength(1);
    const childPath = first[0]!.path;
    closeChild = await bot.core.subscribe(
      id,
      (value) => {
        child = value;
      },
      (message) => {
        childError = message;
      },
      childPath,
    );
    await expect
      .poll(() => childError ?? JSON.stringify(child?.snapshot.transcript), { timeout: 5000 })
      .toContain("First delegated result");
    await expect
      .poll(
        async () =>
          (await bot.core.openThread(id)).snapshot.subagents?.find(
            (item) => item.path === childPath,
          )?.status,
        { timeout: 5000 },
      )
      .toBe("completed");
    const inputs = child!.snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ).length;
    expect(registration).not.toHaveBeenCalled();
    const replay = await request(path, body);
    expect(replay.status).toBe(200);
    expect(Schema.decodeUnknownSync(children)(await replay.json())).toEqual(first);
    provider.setResponses(
      Array.from({ length: 15 }, () => fauxAssistantMessage("Second delegated result")),
    );
    const steered = await request(path, {
      command: { action: "send", path: childPath, message: "Follow-up task", wait: false },
      requestId: "steer-once",
    });
    expect(steered.status).toBe(200);
    await expect
      .poll(() => childError ?? JSON.stringify(child?.snapshot.transcript), { timeout: 5000 })
      .toContain("Second delegated result");
    await expect
      .poll(
        async () =>
          (await bot.core.openThread(id)).snapshot.subagents?.find(
            (item) => item.path === childPath,
          )?.status,
        { timeout: 5000 },
      )
      .toBe("completed");
    await expect.poll(() => bot.controller.status().activeThreads, { timeout: 5000 }).toEqual([]);
    expect(JSON.stringify(child!.snapshot.transcript)).toContain("Follow-up task");
    expect(
      child!.snapshot.transcript.filter((entry) => entry.message.role === "user"),
    ).toHaveLength(inputs + 1);
    expect(registration).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await bot.core.projects()).toHaveLength(1);
    expect((await request("/v1/library")).status).toBe(200);
    expect(await bot.core.projects()).toHaveLength(2);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    closeChild?.();
    registration.mockRestore();
    refresh.mockRestore();
  }
}, 15000);

test("subagent writers retain project leases and cannot resolve another thread's parent", async () => {
  const { bot, provider, request, create } = await fixture();
  await bot.core.stopScheduler();
  const first = await create("subagent-owner");
  const second = await create("subagent-contender");
  const finish = Promise.withResolvers<void>();
  let entered = false;
  provider.setResponses([
    async () => {
      entered = true;
      await finish.promise;
      return fauxAssistantMessage("Held child completed");
    },
  ]);
  try {
    const response = await request("/v1/threads/" + first + "/subagent", {
      command: { action: "spawn", name: "worker", message: "Hold this task", wait: false },
      requestId: "held-spawn",
    });
    expect(response.status).toBe(200);
    const children = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ path: Schema.String })))(
      await response.json(),
    );
    expect(children).toHaveLength(1);
    await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
    expect(bot.controller.status().activeThreads).toContain(first);
    const foreign = await request("/v1/threads/" + second + "/subagent", {
      command: { action: "list", parent: children[0]!.path },
      requestId: "foreign-parent",
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ error: { code: "NotFound" } });
    const command = {
      command: { action: "spawn", name: "contender", message: "Another task", wait: false },
      requestId: "contending-spawn",
    };
    const delegating = vi.spyOn(bot.core, "subagent");
    try {
      const busy = await request("/v1/threads/" + second + "/subagent", command);
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ error: { code: "Busy" } });
      expect(delegating).not.toHaveBeenCalled();
    } finally {
      delegating.mockRestore();
    }
    expect((await bot.core.openThread(second)).snapshot.subagents ?? []).toEqual([]);
    finish.resolve();
    await expect.poll(() => bot.controller.status().activeThreads, { timeout: 5000 }).toEqual([]);
    provider.setResponses(
      Array.from({ length: 5 }, () => fauxAssistantMessage("Retried child completed")),
    );
    const accepted = await request("/v1/threads/" + second + "/subagent", command);
    expect(accepted.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ path: Schema.String })))(
        await accepted.json(),
      ),
    ).toHaveLength(1);
    await expect
      .poll(async () => (await bot.core.openThread(second)).snapshot.subagents?.[0]?.status, {
        timeout: 5000,
      })
      .toBe("completed");
    await expect.poll(() => bot.controller.status().activeThreads, { timeout: 5000 }).toEqual([]);
  } finally {
    finish.resolve();
  }
}, 15000);

// The timer callback is fire-and-forget; await its actual Core reads, then its continuation.
async function advanceRecoveryPoll(inspections: readonly Promise<unknown>[]) {
  await vi.advanceTimersByTimeAsync(250);
  await Promise.allSettled(inspections);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test.each(["during-admission", "after-admission", "failed-inspection"] as const)(
  "a recovery check cannot release a checkout %s of a borrowed subagent writer",
  async (phase) => {
    const { bot, provider, workspace, create } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("borrowed-writer-" + phase);
    const other = await create("borrowed-contender-" + phase);
    const admit = Promise.withResolvers<void>();
    const inspect = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const inspections: Promise<unknown>[] = [];
    const tick = () => advanceRecoveryPoll(inspections);
    let admitting = false;
    let inspecting = false;
    let holdInspection = false;
    let failCurrent = false;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = new BotController(
      {
        ...bot.core,
        recovery: (threadId) => {
          const inspection = (async () => {
            const state = await bot.core.recovery(threadId);
            if (failCurrent && threadId === id)
              throw new Error("Current recovery inspection failed");
            if (holdInspection && threadId === id) {
              holdInspection = false;
              inspecting = true;
              await inspect.promise;
              if (phase === "failed-inspection")
                throw new Error("Previous recovery inspection failed");
            }
            return state;
          })();
          inspections.push(inspection);
          return inspection;
        },
        subagent: async (...args) => {
          admitting = true;
          await admit.promise;
          return bot.core.subagent(...args);
        },
      },
      new Map([[workspace, bot.workspaceProjects.get(workspace)!]]),
      2,
    );
    let spawning: Promise<unknown> | undefined;
    let checking: Promise<void> | undefined;
    try {
      provider.setResponses([fauxAssistantMessage("Root work completed")]);
      await controller.submit(id, "Root work", "borrowed-root");
      await expect
        .poll(async () => (await bot.core.recovery(id)).pending, { timeout: 5000 })
        .toBe(false);
      provider.setResponses(
        Array.from({ length: 4 }, () => async () => {
          await finish.promise;
          return fauxAssistantMessage("Held work completed");
        }),
      );
      if (phase !== "during-admission") {
        holdInspection = true;
        checking = tick();
        await expect.poll(() => inspecting, { timeout: 5000 }).toBe(true);
      }
      spawning = controller.subagent(
        id,
        {
          action: "spawn",
          name: "borrowed",
          message: "Hold this delegated task",
          wait: false,
        },
        "borrowed-spawn",
      );
      // Observe every rejection even if a readiness assertion fails before awaiting the call.
      const observed = Promise.allSettled([spawning]);
      await expect.poll(() => admitting, { timeout: 5000 }).toBe(true);
      if (phase === "during-admission") {
        await tick();
      } else {
        admit.resolve();
        await spawning;
        inspect.resolve();
        await checking;
      }
      const contender = await controller.submit(other, "Competing work", "borrowed-contender").then(
        () => ({ admitted: true }),
        (error: unknown) => ({
          admitted: false,
          code: error instanceof Error && "code" in error ? error.code : undefined,
        }),
      );
      admit.resolve();
      await spawning;
      await observed;
      expect({
        contender,
        ownerPending: (await bot.core.recovery(id)).pending,
        contenderPending: (await bot.core.recovery(other)).pending,
        activeThreads: controller.status().activeThreads,
        blocked: controller.status().blocked,
      }).toEqual({
        contender: { admitted: false, code: "Busy" },
        ownerPending: true,
        contenderPending: false,
        activeThreads: [id],
        blocked: {},
      });
      if (phase === "failed-inspection") {
        failCurrent = true;
        await tick();
        expect(controller.status().blocked).toEqual({ [id]: "Current recovery inspection failed" });
        await expect(
          controller.submit(other, "Competing work", "borrowed-contender"),
        ).rejects.toMatchObject({ code: "Busy" });
        finish.resolve();
        failCurrent = false;
        await controller.stop(id);
      } else {
        finish.resolve();
        await expect
          .poll(async () => (await bot.core.recovery(id)).pending, { timeout: 5000 })
          .toBe(false);
        await tick();
      }
      expect(controller.status().activeThreads).toEqual([]);
      await expect(
        controller.submit(other, "Competing work", "borrowed-contender"),
      ).resolves.toMatchObject({ kind: "run" });
    } finally {
      admit.resolve();
      inspect.resolve();
      finish.resolve();
      try {
        await Promise.allSettled([
          ...(spawning ? [spawning] : []),
          ...(checking ? [checking] : []),
        ]);
        await controller.stop(id);
        await controller.stop(other);
        await controller.close(0);
      } finally {
        vi.useRealTimers();
      }
    }
  },
  15000,
);

test("a rejected borrowed writer cannot release another pending writer's checkout", async () => {
  const { bot, provider, workspace, create } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("overlapping-borrowed-owner");
  const other = await create("overlapping-borrowed-contender");
  const admit = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const inspections: Promise<unknown>[] = [];
  const tick = () => advanceRecoveryPoll(inspections);
  let admitting = false;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const controller = new BotController(
    {
      ...bot.core,
      recovery: (threadId) => {
        const inspection = bot.core.recovery(threadId);
        inspections.push(inspection);
        return inspection;
      },
      subagent: async (...args) => {
        if (args[2] === "overlapping-held-spawn") {
          admitting = true;
          await admit.promise;
        }
        return bot.core.subagent(...args);
      },
    },
    new Map([[workspace, bot.workspaceProjects.get(workspace)!]]),
    2,
  );
  let spawning: Promise<unknown> | undefined;
  try {
    provider.setResponses([fauxAssistantMessage("Root completed")]);
    await controller.submit(id, "Root work", "overlapping-root");
    await expect
      .poll(async () => (await bot.core.recovery(id)).pending, { timeout: 5000 })
      .toBe(false);
    spawning = controller.subagent(
      id,
      {
        action: "spawn",
        name: "held",
        message: "Hold this task",
        wait: false,
      },
      "overlapping-held-spawn",
    );
    const observed = Promise.allSettled([spawning]);
    await expect.poll(() => admitting, { timeout: 5000 }).toBe(true);
    await expect(
      controller.subagent(
        id,
        {
          action: "send",
          path: "/root/missing",
          message: "No such worker",
          wait: false,
        },
        "overlapping-invalid-send",
      ),
    ).rejects.toThrow(/只能管理当前智能体的下级/);
    expect((await bot.core.recovery(id)).pending).toBe(false);
    await tick();
    expect(controller.status().activeThreads).toEqual([id]);
    await expect(
      controller.submit(other, "Competing", "overlapping-contender"),
    ).rejects.toMatchObject({ code: "Busy" });
    provider.setResponses([
      async () => {
        await finish.promise;
        return fauxAssistantMessage("Delegated work completed");
      },
    ]);
    admit.resolve();
    await spawning;
    await observed;
    expect((await bot.core.recovery(id)).pending).toBe(true);
    finish.resolve();
    await expect
      .poll(async () => (await bot.core.recovery(id)).pending, { timeout: 5000 })
      .toBe(false);
    await tick();
    expect(controller.status().activeThreads).toEqual([]);
    await expect(
      controller.submit(other, "Competing", "overlapping-contender"),
    ).resolves.toMatchObject({ kind: "run" });
  } finally {
    admit.resolve();
    finish.resolve();
    try {
      await Promise.allSettled(spawning ? [spawning] : []);
      await controller.stop(id);
      await controller.stop(other);
      await controller.close(0);
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test.each(["list", "spawn", "send", "stop", "wait"] as const)(
  "subagent %s rechecks a formerly visible workspace before reaching Core",
  async (action) => {
    const { bot, request, create, config, cwd, workspace } = await fixture();
    await bot.core.stopScheduler();
    const id = await create("subagent-revocation-" + action);
    const outside = join(config.dataRoot, "outside");
    await rename(cwd, outside);
    await symlink(outside, cwd, "dir");
    expect(bot.workspaceProjects.has(workspace)).toBe(true);
    const delegating = vi.spyOn(bot.core, "subagent");
    try {
      const command =
        action === "list"
          ? { action }
          : action === "spawn"
            ? { action, name: "worker", message: "No", wait: false }
            : action === "send"
              ? { action, path: "/root/worker", message: "No", wait: false }
              : { action, path: "/root/worker" };
      const response = await request("/v1/threads/" + id + "/subagent", {
        command,
        requestId: "denied",
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
      expect(bot.workspaceProjects.has(workspace)).toBe(false);
      expect(delegating).not.toHaveBeenCalled();
      expect(bot.controller.status().activeThreads).toEqual([]);
    } finally {
      delegating.mockRestore();
    }
  },
);

test("targeted subagent commands retain authentication, size, input and shutdown guards", async () => {
  const { bot, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("subagent-guards");
  const path = "/v1/threads/" + id + "/subagent";
  const metadata = vi.spyOn(bot.core, "threadMetadata");
  try {
    expect((await bot.app.request(path, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await bot.app.request(path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + config.adminToken,
            "content-length": String(48 * 1024 * 1024 + 1),
          },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    expect(metadata).not.toHaveBeenCalled();
    expect((await request(path, { command: { action: "invalid" }, requestId: "bad" })).status).toBe(
      400,
    );
    await bot.close();
    metadata.mockClear();
    expect((await request(path, { command: { action: "list" }, requestId: "closed" })).status).toBe(
      503,
    );
    expect(metadata).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
  }
});

async function workspaceRequestFixture(environment?: Partial<CoreEnvironment>) {
  const context = await fixture(false, undefined, undefined, environment);
  await context.bot.core.stopScheduler();
  const git = (...args: string[]) =>
    promisify(execFile)(
      "git",
      ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args],
      { cwd: context.cwd },
    );
  await git("init", "-q", "-b", "main");
  await writeFile(join(context.cwd, "README.md"), "Workspace scope fixture\n");
  const skill = join(context.cwd, ".agents", "skills", "scoped-skill");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: scoped-skill\ndescription: Workspace scope fixture\n---\nUse this workspace.\n",
  );
  await git("add", ".");
  await git("commit", "-q", "-m", "fixture");
  return { ...context, git };
}

test.each(["create", "skills", "git", "branches"] as const)(
  "workspace %s requests leave unrelated discovery to the catalog",
  async (kind) => {
    const { bot, request, config, workspace } = await workspaceRequestFixture();
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const registration = vi.spyOn(bot.core, "registerProject");
    const creation = vi.spyOn(bot.core, "createThread");
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    try {
      if (kind === "create") {
        const body = {
          workspaceId: workspace,
          requestId: "scoped-create",
          configuration: {
            provider: "bot-test",
            modelId: "one",
            thinkingLevel: "off",
            sandboxMode: "read-only",
          },
        };
        const created = await request("/v1/threads", body);
        expect(created.status).toBe(201);
        const thread = Schema.decodeUnknownSync(identity)(await created.json());
        const replay = await request("/v1/threads", body);
        expect(replay.status).toBe(201);
        expect(Schema.decodeUnknownSync(identity)(await replay.json())).toEqual(thread);
        expect(creation).toHaveBeenCalledTimes(1);
        expect((await bot.core.openThread(thread.id)).snapshot.configuration.model).toMatchObject({
          provider: "bot-test",
          modelId: "one",
        });
        expect((await bot.core.openThread(thread.id)).snapshot.sandbox?.mode).toBe("read-only");
      } else {
        const response = await request(
          kind === "skills"
            ? "/v1/skills?workspaceId=" + workspace
            : "/v1/workspaces/" + workspace + "/" + kind,
        );
        expect(response.status).toBe(200);
        const value = await response.json();
        if (kind === "skills")
          expect(value).toMatchObject({
            skills: expect.arrayContaining([
              expect.objectContaining({ name: "scoped-skill", source: "project" }),
            ]),
          });
        else if (kind === "git")
          expect(value).toMatchObject({
            status: "ready",
            linkedWorktree: false,
            head: { name: "main" },
          });
        else
          expect(value).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "main", current: true })]),
          );
      }
      expect(registration).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(await bot.core.projects()).toHaveLength(1);
      expect((await request("/v1/library")).status).toBe(200);
      expect(await bot.core.projects()).toHaveLength(2);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      registration.mockRestore();
      creation.mockRestore();
      refresh.mockRestore();
    }
  },
);

test("workspace creation replays recheck scope before returning a cached receipt", async () => {
  const { bot, request, config, cwd, workspace } = await fixture();
  await bot.core.stopScheduler();
  const body = { workspaceId: workspace, requestId: "workspace-create-receipt" };
  expect((await request("/v1/threads", body)).status).toBe(201);
  const outside = join(config.dataRoot, "outside");
  await rename(cwd, outside);
  await symlink(outside, cwd, "dir");
  expect(bot.workspaceProjects.has(workspace)).toBe(true);
  const creation = vi.spyOn(bot.core, "createThread");
  try {
    expect((await request("/v1/threads", body)).status).toBe(403);
    expect(
      (await request("/v1/threads", { ...body, requestId: "new-after-revocation" })).status,
    ).toBe(403);
    expect(creation).not.toHaveBeenCalled();
    expect(bot.workspaceProjects.has(workspace)).toBe(false);
  } finally {
    creation.mockRestore();
  }
});

test.each(["skills", "git", "branches"] as const)(
  "workspace %s rejects an escaped checkout before Core reads",
  async (kind) => {
    const { bot, request, config, cwd, workspace } = await fixture();
    await bot.core.stopScheduler();
    const outside = join(config.dataRoot, "outside");
    await rename(cwd, outside);
    await symlink(outside, cwd, "dir");
    const skills = vi.spyOn(bot.core, "skills");
    const repository = vi.spyOn(bot.core, "gitRepository");
    const branches = vi.spyOn(bot.core, "gitBranches");
    try {
      const response = await request(
        kind === "skills"
          ? "/v1/skills?workspaceId=" + workspace
          : "/v1/workspaces/" + workspace + "/" + kind,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
      expect(skills).not.toHaveBeenCalled();
      expect(repository).not.toHaveBeenCalled();
      expect(branches).not.toHaveBeenCalled();
    } finally {
      skills.mockRestore();
      repository.mockRestore();
      branches.mockRestore();
    }
  },
);

async function scopedWorktreeFixture() {
  const context = await workspaceRequestFixture();
  const projectId = context.bot.workspaceProjects.get(context.workspace)!;
  const worktree = await context.bot.core.createWorktree({
    projectId,
    baseWorkspaceId: context.workspace,
    branch: { kind: "new", name: "eta/scoped-workspace" },
    requestId: "scope-worktree",
  });
  expect(worktree.workspaceId).toBeTypeOf("string");
  return { ...context, projectId, worktree, worktreeId: worktree.workspaceId! };
}

test("workspace removal retains dirty protection and cached removal without unrelated discovery", async () => {
  const { bot, request, config, cwd, worktree, worktreeId, git } = await scopedWorktreeFixture();
  expect(bot.workspaceProjects.has(worktreeId)).toBe(false);
  await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
  const dirty = join(worktree.cwd, "untracked.txt");
  await writeFile(dirty, "Do not delete this");
  const registration = vi.spyOn(bot.core, "registerProject");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  const path = "/v1/workspaces/" + worktreeId + "/remove";
  try {
    expect((await request(path, { requestId: "remove" })).status).toBe(400);
    expect(await readFile(dirty, "utf8")).toBe("Do not delete this");
    await rm(dirty);
    const removed = await request(path, { requestId: "remove" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ workspaceId: worktreeId, status: "removed" });
    await expect(readFile(join(worktree.path, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    const replay = await request(path, { requestId: "remove" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ workspaceId: worktreeId, status: "removed" });
    await git("show-ref", "--verify", "refs/heads/eta/scoped-workspace");
    expect(registration).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await bot.core.projects()).toHaveLength(1);
    expect((await request("/v1/library")).status).toBe(200);
    expect(await bot.core.projects()).toHaveLength(2);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    const outside = join(config.dataRoot, "removed-project-outside");
    await rename(cwd, outside);
    await symlink(outside, cwd, "dir");
    expect((await request(path, { requestId: "remove" })).status).toBe(403);
  } finally {
    registration.mockRestore();
    refresh.mockRestore();
  }
}, 15000);

test.each(["git", "branches", "remove"] as const)(
  "workspace %s also rejects an escaped project root with an inside worktree",
  async (kind) => {
    const { bot, request, config, cwd, worktree, worktreeId } = await scopedWorktreeFixture();
    expect((await request("/v1/workspaces/" + worktreeId + "/git")).status).toBe(200);
    const outside = join(config.dataRoot, "project-outside");
    await rename(cwd, outside);
    await symlink(outside, cwd, "dir");
    // The target checkout still exists inside Bot's root; its owning project is what escaped.
    expect(await readFile(join(worktree.path, "README.md"), "utf8")).toContain(
      "Workspace scope fixture",
    );
    expect(bot.workspaceProjects.has(worktreeId)).toBe(true);
    const repository = vi.spyOn(bot.core, "gitRepository");
    const branches = vi.spyOn(bot.core, "gitBranches");
    const remove = vi.spyOn(bot.core, "removeWorktree");
    try {
      const response = await request(
        "/v1/workspaces/" + worktreeId + "/" + kind,
        kind === "remove" ? { requestId: "denied" } : undefined,
      );
      expect(response.status).toBe(403);
      expect(bot.workspaceProjects.has(worktreeId)).toBe(false);
      expect(repository).not.toHaveBeenCalled();
      expect(branches).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      repository.mockRestore();
      branches.mockRestore();
      remove.mockRestore();
    }
  },
);

test("workspace creation follows visible aliases but rejects replay after the alias is removed", async () => {
  const { bot, request, config } = await fixture();
  await bot.core.stopScheduler();
  const hidden = join(config.workspaceRoot, ".hidden");
  await mkdir(hidden);
  const project = await bot.core.registerProject(hidden);
  const [workspace] = await bot.core.workspaces(project.id);
  const alias = join(config.workspaceRoot, "visible-alias");
  await symlink(hidden, alias, "dir");
  const body = { workspaceId: workspace!.id, requestId: "alias-create" };
  const first = await request("/v1/threads", body);
  expect(first.status).toBe(201);
  const thread = Schema.decodeUnknownSync(identity)(await first.json());
  expect((await bot.core.threadMetadata(thread.id)).workspaceId).toBe(workspace!.id);
  await rm(alias);
  expect((await request("/v1/threads", body)).status).toBe(403);
  expect((await request("/v1/skills?workspaceId=" + workspace!.id)).status).toBe(403);
});

test("workspace requests preserve guards and reject missing or unknown targets", async () => {
  const { bot, request, config, workspace } = await fixture();
  await bot.core.stopScheduler();
  const reads = [
    "/v1/skills?workspaceId=" + workspace,
    "/v1/workspaces/" + workspace + "/git",
    "/v1/workspaces/" + workspace + "/branches",
  ];
  const writes = ["/v1/threads", "/v1/workspaces/" + workspace + "/remove"];
  const scoped = vi.spyOn(BotProjects.prototype, "refreshForWorkspace");
  const creation = vi.spyOn(bot.core, "createThread");
  const removal = vi.spyOn(bot.core, "removeWorktree");
  try {
    for (const path of reads) expect((await bot.app.request(path)).status).toBe(401);
    for (const path of writes) {
      expect((await bot.app.request(path, { method: "POST", body: "{}" })).status).toBe(401);
      expect(
        (
          await bot.app.request(path, {
            method: "POST",
            headers: {
              authorization: "Bearer " + config.adminToken,
              "content-length": String(48 * 1024 * 1024 + 1),
            },
            body: "{}",
          })
        ).status,
      ).toBe(413);
    }
    expect(scoped).not.toHaveBeenCalled();
    expect((await request("/v1/threads", {})).status).toBe(400);
    expect((await request(writes[1]!, {})).status).toBe(400);
    expect((await request("/v1/skills")).status).toBe(403);
    expect((await request("/v1/skills?workspaceId=unknown")).status).toBe(403);
    expect((await request("/v1/workspaces/unknown/git")).status).toBe(403);
    expect((await request("/v1/workspaces/unknown/branches")).status).toBe(403);
    expect((await request("/v1/workspaces/unknown/remove", { requestId: "unknown" })).status).toBe(
      403,
    );
    expect(
      (await request("/v1/threads", { workspaceId: "unknown", requestId: "unknown" })).status,
    ).toBe(403);
    expect(creation).not.toHaveBeenCalled();
    expect(removal).not.toHaveBeenCalled();
    await bot.close();
    scoped.mockClear();
    for (const path of reads) expect((await request(path)).status).toBe(503);
    expect(
      (await request("/v1/threads", { workspaceId: workspace, requestId: "closed" })).status,
    ).toBe(503);
    expect((await request(writes[1]!, { requestId: "closed" })).status).toBe(503);
    expect(scoped).not.toHaveBeenCalled();
  } finally {
    scoped.mockRestore();
    creation.mockRestore();
    removal.mockRestore();
  }
});

async function projectRequestFixture() {
  const requests: string[] = [];
  const context = await workspaceRequestFixture({
    github: {
      async session() {
        return {
          key: "project-scope-session",
          identity: { authenticated: true, login: "scope-user", source: "gh" as const },
          async request(path: string) {
            requests.push(path);
            return {
              status: 200,
              headers: {},
              body: [
                {
                  number: 1,
                  title: "Scoped issue",
                  state: "open",
                  user: { login: "scope-user" },
                  updated_at: "2026-10-21T00:00:00Z",
                  html_url: "https://github.com/eta-fixture/scoped/issues/1",
                  labels: [],
                },
              ],
            };
          },
        };
      },
    },
  });
  await context.git("remote", "add", "origin", "https://github.com/eta-fixture/scoped.git");
  return { ...context, requests, projectId: context.bot.workspaceProjects.get(context.workspace)! };
}

test.each(["identity", "query", "remote", "worktrees", "reconcile", "create"] as const)(
  "project %s requests do not discover unrelated projects before Core work",
  async (kind) => {
    const { bot, request, config, workspace, projectId, requests } = await projectRequestFixture();
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const events: string[] = [];
    const register = bot.core.registerProject;
    const identity = bot.core.githubIdentity;
    const query = bot.core.githubQuery;
    const remote = bot.core.selectGitHubRemote;
    const list = bot.core.listWorktrees;
    const reconcile = bot.core.reconcileWorktrees;
    const create = bot.core.createWorktree;
    const spies = [
      vi.spyOn(bot.core, "registerProject").mockImplementation((...args) => {
        events.push("discover");
        return register(...args);
      }),
      vi.spyOn(bot.core, "githubIdentity").mockImplementation((...args) => {
        events.push("identity");
        return identity(...args);
      }),
      vi.spyOn(bot.core, "githubQuery").mockImplementation((...args) => {
        events.push("query");
        return query(...args);
      }),
      vi.spyOn(bot.core, "selectGitHubRemote").mockImplementation((...args) => {
        events.push("remote");
        return remote(...args);
      }),
      vi.spyOn(bot.core, "listWorktrees").mockImplementation((...args) => {
        events.push("worktrees");
        return list(...args);
      }),
      vi.spyOn(bot.core, "reconcileWorktrees").mockImplementation((...args) => {
        events.push("reconcile");
        return reconcile(...args);
      }),
      vi.spyOn(bot.core, "createWorktree").mockImplementation((...args) => {
        events.push("create");
        return create(...args);
      }),
    ];
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    try {
      const base = "/v1/projects/" + projectId;
      const response =
        kind === "identity"
          ? await request(base + "/github/identity")
          : kind === "query"
            ? await request(base + "/github", { kind: "issues", state: "open" })
            : kind === "remote"
              ? await request(base + "/github-remote", {
                  remoteName: "origin",
                  requestId: "select",
                })
              : kind === "worktrees"
                ? await request(base + "/worktrees")
                : kind === "reconcile"
                  ? await request(base + "/worktrees/reconcile", {})
                  : await request(base + "/worktrees", {
                      baseWorkspaceId: workspace,
                      branch: { kind: "new", name: "eta/project-scope" },
                      requestId: "project-worktree",
                    });
      expect(response.status).toBe(kind === "create" ? 201 : 200);
      const value = await response.json();
      if (kind === "identity")
        expect(value).toMatchObject({ authenticated: true, login: "scope-user", source: "gh" });
      else if (kind === "query") {
        expect(value).toMatchObject({
          status: "ready",
          repository: { projectId, owner: "eta-fixture", repo: "scoped" },
          items: [expect.objectContaining({ title: "Scoped issue" })],
        });
        expect(requests[0]).toContain("repos/eta-fixture/scoped/issues");
      } else if (kind === "remote")
        expect(value).toMatchObject({
          status: "ready",
          github: { selection: { remote: "origin", reason: "saved" } },
        });
      else if (kind === "create")
        expect(value).toMatchObject({
          projectId,
          status: "ready",
          branch: "eta/project-scope",
          workspaceId: expect.any(String),
        });
      else expect(value).toEqual([]);
      expect(events[0]).toBe(kind);
      const publishesDirectory = kind === "create" || kind === "reconcile";
      expect(refresh).toHaveBeenCalledTimes(publishesDirectory ? 1 : 0);
      expect(spies[0]).toHaveBeenCalledTimes(publishesDirectory ? 1 : 0);
      expect(await bot.core.projects()).toHaveLength(publishesDirectory ? 2 : 1);
      if (publishesDirectory) expect(events).toEqual([kind, "discover"]);
      expect((await request("/v1/library")).status).toBe(200);
      expect(await bot.core.projects()).toHaveLength(2);
      expect(spies[0]).toHaveBeenCalledTimes(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
      refresh.mockRestore();
    }
  },
);

test.each(["identity", "query", "remote", "worktrees", "reconcile", "create"] as const)(
  "project %s rejects an escaped root despite an old inside-worktree grant",
  async (kind) => {
    const { bot, request, config, cwd, workspace, projectId } = await projectRequestFixture();
    const worktree = await bot.core.createWorktree({
      projectId,
      baseWorkspaceId: workspace,
      branch: { kind: "new", name: "eta/inside-worktree" },
      requestId: "inside",
    });
    expect((await request("/v1/workspaces/" + worktree.workspaceId! + "/git")).status).toBe(200);
    const outside = join(config.dataRoot, "project-outside");
    await rename(cwd, outside);
    await symlink(outside, cwd, "dir");
    expect(await readFile(join(worktree.path, "README.md"), "utf8")).toContain(
      "Workspace scope fixture",
    );
    expect(bot.workspaceProjects.get(worktree.workspaceId!)).toBe(projectId);
    const spies = [
      vi.spyOn(bot.core, "githubIdentity"),
      vi.spyOn(bot.core, "githubQuery"),
      vi.spyOn(bot.core, "selectGitHubRemote"),
      vi.spyOn(bot.core, "listWorktrees"),
      vi.spyOn(bot.core, "reconcileWorktrees"),
      vi.spyOn(bot.core, "createWorktree"),
    ];
    try {
      const base = "/v1/projects/" + projectId;
      const response =
        kind === "identity"
          ? await request(base + "/github/identity")
          : kind === "query"
            ? await request(base + "/github", { kind: "issues", state: "open" })
            : kind === "remote"
              ? await request(base + "/github-remote", {
                  remoteName: "origin",
                  requestId: "denied",
                })
              : kind === "worktrees"
                ? await request(base + "/worktrees")
                : kind === "reconcile"
                  ? await request(base + "/worktrees/reconcile", {})
                  : await request(base + "/worktrees", {
                      baseWorkspaceId: workspace,
                      branch: { kind: "new", name: "eta/denied" },
                      requestId: "denied",
                    });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  },
);

test("project worktree creation rechecks an escaped base before replaying a cached receipt", async () => {
  const { bot, request, config, workspace, projectId } = await projectRequestFixture();
  const source = await bot.core.createWorktree({
    projectId,
    baseWorkspaceId: workspace,
    branch: { kind: "new", name: "eta/source" },
    requestId: "source",
  });
  expect((await request("/v1/workspaces/" + source.workspaceId! + "/git")).status).toBe(200);
  const path = "/v1/projects/" + projectId + "/worktrees";
  const body = {
    baseWorkspaceId: source.workspaceId!,
    branch: { kind: "new", name: "eta/derived" },
    requestId: "derived",
  };
  const first = await request(path, body);
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ status: "ready", branch: "eta/derived" });
  const outside = join(config.dataRoot, "source-outside");
  await rename(source.path, outside);
  await symlink(outside, source.path, "dir");
  expect(bot.workspaceProjects.get(workspace)).toBe(projectId);
  expect(bot.workspaceProjects.get(source.workspaceId!)).toBe(projectId);
  const creation = vi.spyOn(bot.core, "createWorktree");
  try {
    expect((await request(path, body)).status).toBe(403);
    expect(
      (
        await request(path, {
          ...body,
          branch: { kind: "new", name: "eta/another" },
          requestId: "another",
        })
      ).status,
    ).toBe(403);
    expect(creation).not.toHaveBeenCalled();
    expect(bot.workspaceProjects.has(source.workspaceId!)).toBe(false);
  } finally {
    creation.mockRestore();
  }
});

test("project worktree creation keeps Core's different-project base rejection", async () => {
  const { bot, request, config, projectId } = await projectRequestFixture();
  const other = join(config.workspaceRoot, "other-project");
  await mkdir(other);
  const project = await bot.core.registerProject(other);
  const [workspace] = await bot.core.workspaces(project.id);
  const response = await request("/v1/projects/" + projectId + "/worktrees", {
    baseWorkspaceId: workspace!.id,
    branch: { kind: "new", name: "eta/foreign" },
    requestId: "foreign",
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "InvalidInput" } });
  expect(await bot.core.listWorktrees(projectId)).toEqual([]);
});

test.each(["missing", "multiple"] as const)(
  "project scope falls back to discovery with %s root metadata",
  async (shape) => {
    const { bot, request, config, workspace, projectId } = await projectRequestFixture();
    await bot.core.createWorktree({
      projectId,
      baseWorkspaceId: workspace,
      branch: { kind: "new", name: "eta/fallback" },
      requestId: "fallback",
    });
    await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
    const list = bot.core.workspaces;
    const metadata = vi.spyOn(bot.core, "workspaces").mockImplementation(async (...args) => {
      const values = await list(...args);
      const root = values.find(
        (value) => value.projectId === projectId && value.kind === "project-root",
      );
      if (!root) return values;
      return shape === "missing"
        ? values.filter((value) => value.id !== root.id)
        : [...values, { ...root, id: "extra-root" }];
    });
    const refresh = vi.spyOn(BotProjects.prototype, "refresh");
    const registration = vi.spyOn(bot.core, "registerProject");
    try {
      const response = await request("/v1/projects/" + projectId + "/github/identity");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ authenticated: true, login: "scope-user" });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(registration).toHaveBeenCalledTimes(1);
      expect([...bot.workspaceProjects.values()]).toContain(projectId);
    } finally {
      metadata.mockRestore();
      refresh.mockRestore();
      registration.mockRestore();
    }
  },
);

test("project identity follows visible aliases and rejects them after revocation", async () => {
  const { bot, request, config } = await projectRequestFixture();
  const hidden = join(config.workspaceRoot, ".hidden-project");
  await mkdir(hidden);
  const project = await bot.core.registerProject(hidden);
  const alias = join(config.workspaceRoot, "visible-project");
  await symlink(hidden, alias, "dir");
  const path = "/v1/projects/" + project.id + "/github/identity";
  expect((await request(path)).status).toBe(200);
  await rm(alias);
  const identity = vi.spyOn(bot.core, "githubIdentity");
  try {
    expect((await request(path)).status).toBe(403);
    expect(identity).not.toHaveBeenCalled();
  } finally {
    identity.mockRestore();
  }
});

test("project-scoped routes retain global guards and reject unknown projects", async () => {
  const { bot, request, config, projectId, requests } = await projectRequestFixture();
  const base = "/v1/projects/" + projectId;
  const reads = [base + "/github/identity", base + "/worktrees"];
  const writes = [
    base + "/github",
    base + "/github-remote",
    base + "/worktrees/reconcile",
    base + "/worktrees",
  ];
  const metadata = vi.spyOn(bot.core, "workspaces");
  try {
    for (const path of reads) expect((await bot.app.request(path)).status).toBe(401);
    for (const path of writes) {
      expect((await bot.app.request(path, { method: "POST", body: "{}" })).status).toBe(401);
      expect(
        (
          await bot.app.request(path, {
            method: "POST",
            headers: {
              authorization: "Bearer " + config.adminToken,
              "content-length": String(48 * 1024 * 1024 + 1),
            },
            body: "{}",
          })
        ).status,
      ).toBe(413);
    }
    expect(metadata).not.toHaveBeenCalled();
    expect(
      (await request(base + "/github", { kind: "issues", state: "open", owner: "caller-supplied" }))
        .status,
    ).toBe(400);
    expect((await request(base + "/github-remote", { remoteName: 123 })).status).toBe(400);
    expect((await request(base + "/worktrees", {})).status).toBe(400);
    for (const suffix of ["github/identity", "worktrees"])
      expect((await request("/v1/projects/unknown/" + suffix)).status).toBe(403);
    for (const suffix of ["github", "github-remote", "worktrees/reconcile", "worktrees"])
      expect((await request("/v1/projects/unknown/" + suffix, {})).status).toBe(403);
    expect(requests).toEqual([]);
    await bot.close();
    metadata.mockClear();
    for (const path of reads) expect((await request(path)).status).toBe(503);
    for (const path of writes) expect((await request(path, {})).status).toBe(503);
    expect(metadata).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
  }
});

test("ordinary messages and cached receipts do not discover unrelated projects", async () => {
  const { bot, provider, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("targeted-discovery");
  await mkdir(join(config.workspaceRoot, "unrelated-new-project"));
  provider.setResponses([fauxAssistantMessage("Accepted once")]);
  const registration = vi.spyOn(bot.core, "registerProject");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  const submit = vi.spyOn(bot.core, "submit");
  try {
    const body = { requestId: "targeted-input", prompt: "Hello" };
    const accepted = await request("/v1/threads/" + id + "/messages", body);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    expect(registration).not.toHaveBeenCalled();
    expect(await bot.core.projects()).toHaveLength(1);
    const replay = await request("/v1/threads/" + id + "/messages", body);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(receipt);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    // Directory reads still discover new projects and publish their workspaces.
    expect((await request("/v1/library")).status).toBe(200);
    expect(await bot.core.projects()).toHaveLength(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(registration).toHaveBeenCalledTimes(1);
  } finally {
    registration.mockRestore();
    refresh.mockRestore();
    submit.mockRestore();
    await bot.controller.stop(id);
  }
});

test("message scope is fresh before both cached replies and new admissions", async () => {
  const { bot, provider, request, create, config, cwd, workspace } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("fresh-target");
  provider.setResponses([fauxAssistantMessage("Done")]);
  const path = "/v1/threads/" + id + "/messages";
  const body = { requestId: "before-escape", prompt: "Hello" };
  const accepted = await request(path, body);
  expect(accepted.status).toBe(202);
  const receipt = Schema.decodeUnknownSync(admission)(await accepted.json());
  await expect
    .poll(async () => (await bot.core.operation(id, receipt.operationId)).status)
    .toBe("completed");
  const outside = join(config.dataRoot, "outside");
  await rename(cwd, outside);
  await symlink(outside, cwd, "dir");
  const submit = vi.spyOn(bot.core, "submit");
  try {
    expect((await request(path, body)).status).toBe(403);
    expect(bot.workspaceProjects.has(workspace)).toBe(false);
    expect((await request(path, { requestId: "after-escape", prompt: "No" })).status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
    expect(await bot.core.operationByRequest(id, "http:messages:after-escape")).toBeUndefined();
  } finally {
    submit.mockRestore();
  }
});

test("targeted messages retain authentication, body limits, input checks and shutdown guards", async () => {
  const { bot, request, create, config } = await fixture();
  await bot.core.stopScheduler();
  const id = await create("message-guards");
  const path = "/v1/threads/" + id + "/messages";
  const metadata = vi.spyOn(bot.core, "threadMetadata");
  try {
    expect((await bot.app.request(path, { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await bot.app.request(path, {
          method: "POST",
          headers: {
            authorization: "Bearer " + config.adminToken,
            "content-length": String(48 * 1024 * 1024 + 1),
          },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    expect(metadata).not.toHaveBeenCalled();
    expect((await request(path, {})).status).toBe(400);
    await bot.close();
    metadata.mockClear();
    expect((await request(path, { requestId: "closed", prompt: "No" })).status).toBe(503);
    expect(metadata).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
  }
});

test("message authorization never opens full history before admission or idempotent replay", async () => {
  const { bot, provider, request, create } = await fixture();
  const id = await create("lightweight-admission");
  provider.setResponses([fauxAssistantMessage("Accepted once")]);
  const calls: string[] = [];
  const open = bot.core.openThread;
  const submit = bot.core.submit;
  const opening = vi.spyOn(bot.core, "openThread").mockImplementation((...args) => {
    calls.push("open");
    return open(...args);
  });
  const submitting = vi.spyOn(bot.core, "submit").mockImplementation((...args) => {
    calls.push("submit");
    return submit(...args);
  });
  try {
    const body = { requestId: "lightweight-input", prompt: "Hello" };
    const accepted = await request(`/v1/threads/${id}/messages`, body);
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json();
    expect(calls.slice(0, calls.indexOf("submit"))).toEqual([]);
    const beforeReplay = opening.mock.calls.length;
    const replay = await request(`/v1/threads/${id}/messages`, body);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(receipt);
    expect(opening.mock.calls.length).toBe(beforeReplay);
    expect(submitting).toHaveBeenCalledTimes(1);
    const beforeRead = opening.mock.calls.length;
    const history = await request(`/v1/threads/${id}`);
    expect(history.status).toBe(200);
    expect(Schema.decodeUnknownSync(identity)(await history.json()).id).toBe(id);
    expect(opening.mock.calls.length).toBe(beforeRead + 1);
  } finally {
    opening.mockRestore();
    submitting.mockRestore();
    await bot.controller.stop(id);
  }
}, 15000);

test("admission rechecks workspace scope after its receipt lookup", async () => {
  const { bot, workspace, create } = await fixture();
  const id = await create("revoked-before-admission");
  const allowed = new Map(bot.workspaceProjects);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const submit = vi.fn(bot.core.submit);
  const controller = new BotController(
    {
      ...bot.core,
      operationByRequest: async (...args) => {
        const result = await bot.core.operationByRequest(...args);
        entered.resolve();
        await release.promise;
        return result;
      },
      submit,
    },
    allowed,
    1,
  );
  const pending = controller.submit(id, "Not admitted", "revoked-input");
  const outcome = expect(pending).rejects.toMatchObject({ code: "ProjectUnavailable" });
  try {
    await entered.promise;
    allowed.delete(workspace);
    release.resolve();
    await outcome;
    expect(submit).not.toHaveBeenCalled();
    expect(controller.status().activeThreads).toEqual([]);
  } finally {
    release.resolve();
    await pending.catch(() => {});
    await controller.close(0);
  }
});

test.each(["read", "messages", "operations/missing", "stop", "compact", "subagent"])(
  "out-of-scope thread %s is rejected without opening its history",
  async (action) => {
    const { bot, cwd, request } = await fixture();
    const nested = join(cwd, "not-an-exposed-project");
    await mkdir(nested);
    const project = await bot.core.registerProject(nested);
    const [workspace] = await bot.core.workspaces(project.id);
    const thread = await bot.core.createThread(workspace!.id);
    const opening = vi.spyOn(bot.core, "openThread");
    try {
      const path = `/v1/threads/${thread.id}` + (action === "read" ? "" : "/" + action);
      const response = await request(
        path,
        ["read", "operations/missing"].includes(action)
          ? undefined
          : action === "messages"
            ? { requestId: "outside", prompt: "Not allowed" }
            : {},
      );
      expect(response.status).toBe(403);
      expect(opening).not.toHaveBeenCalled();
    } finally {
      opening.mockRestore();
    }
  },
);

test("HTTP history and SSE omit internal signatures while durable Core history keeps them", async () => {
  const { bot, provider, request, create } = await fixture();
  const answer = fauxAssistantMessage("Visible response");
  answer.content.unshift({
    type: "thinking",
    thinking: "Visible reasoning",
    thinkingSignature: "continuation-payload".repeat(10000),
  });
  provider.setResponses([answer]);
  const id = await create("display-history");
  const admitted = await request(`/v1/threads/${id}/messages`, {
    requestId: "display-input",
    prompt: "Hello",
  });
  const operation = Schema.decodeUnknownSync(admission)(await admitted.json());
  await expect
    .poll(async () => (await bot.core.operation(id, operation.operationId)).status)
    .toBe("completed");
  const history = await (await request(`/v1/threads/${id}`)).text();
  expect(history).toContain("Visible reasoning");
  expect(history).toContain("Visible response");
  expect(history).not.toContain("continuation-payload");
  const controller = new AbortController();
  const events = await bot.app.request(`/v1/threads/${id}/events`, {
    headers: { authorization: "Bearer test-admin-token" },
    signal: controller.signal,
  });
  const reader = events.body!.getReader();
  try {
    const event = new TextDecoder().decode((await reader.read()).value);
    expect(event).toContain("Visible response");
    expect(event).not.toContain("continuation-payload");
  } finally {
    controller.abort();
    await reader.cancel();
  }
  expect(JSON.stringify((await bot.core.openThread(id)).snapshot)).toContain(
    "continuation-payload",
  );
});

test("HTTP operation results omit continuation signatures without modifying durable answers", async () => {
  const { bot, provider, request, create } = await fixture();
  const answer = fauxAssistantMessage("Visible operation answer");
  answer.content.unshift({
    type: "thinking",
    thinking: "Visible operation reasoning",
    thinkingSignature: "operation-continuation".repeat(10000),
  });
  provider.setResponses([answer]);
  const id = await create("display-operation");
  const accepted = await request(`/v1/threads/${id}/messages`, {
    requestId: "display-operation-input",
    prompt: "Hello",
  });
  const { operationId } = Schema.decodeUnknownSync(admission)(await accepted.json());
  await expect
    .poll(async () => (await bot.core.operation(id, operationId)).status, { timeout: 10000 })
    .toBe("completed");
  const result = await request(`/v1/threads/${id}/operations/${operationId}`);
  expect(result.status).toBe(200);
  const wire = await result.text();
  expect(wire).toContain("Visible operation reasoning");
  expect(wire).toContain("Visible operation answer");
  expect(new TextEncoder().encode(wire).byteLength).toBeLessThan(2000);
  expect(wire).not.toContain("operation-continuation");
  const decoded = OperationSchema.parse(JSON.parse(wire));
  expect(decoded).toMatchObject({ operationId, status: "completed" });
  expect(JSON.stringify(await bot.core.operation(id, operationId))).toContain(
    "operation-continuation",
  );
});

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
    // Admission no longer spends native startup time projecting three histories first.
    .poll(async () => (await bot.core.operation(id, accepted.operationId)).status, {
      timeout: 10000,
    })
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
}, 15000);

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
    capabilities: expect.arrayContaining(["agent-mode", "approval-review", "git-metadata"]),
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

test("a stalled SSE reader receives the latest snapshot without a backlog of revisions", async () => {
  const { bot, models, create } = await fixture();
  models.setProvider(
    fauxProvider({
      provider: "backpressure-test",
      models: [{ id: "one" }, { id: "two" }, { id: "latest" }],
    }).provider,
  );
  const id = await create("slow-sse-thread");
  const observed: string[] = [];
  const stop = await bot.core.subscribe(
    id,
    (value) => {
      observed.push(value.snapshot.configuration.model.modelId);
    },
    (message) => {
      throw new Error(message);
    },
  );
  const abort = new AbortController();
  const response = await bot.app.request(`/v1/threads/${id}/events`, {
    headers: { authorization: "Bearer test-admin-token" },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  try {
    // Leave the SSE body unread while an independent observer confirms each revision commits.
    for (let index = 0; index < 20; index++) {
      const model = index % 2 ? "one" : "two";
      await bot.core.configureThread(id, "backpressure-test", model, "off");
      await expect.poll(() => observed.at(-1)).toBe(model);
    }
    await bot.core.configureThread(id, "backpressure-test", "latest", "off");
    await expect.poll(() => observed.at(-1)).toBe("latest");
    const snapshots: SnapshotResponse[] = [];
    while (snapshots.at(-1)?.snapshot.configuration.model.modelId !== "latest") {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      const data = new TextDecoder()
        .decode(chunk.value)
        .split("\n")
        .find((line) => line.startsWith("data: "))!;
      snapshots.push(JSON.parse(data.slice(6)) as SnapshotResponse);
      expect(snapshots.length).toBeLessThanOrEqual(3);
    }
  } finally {
    stop();
    abort.abort();
    await reader.cancel();
  }
});

test("admission monitoring releases capacity without projecting conversation snapshots", async () => {
  const { bot, provider, create } = await fixture();
  const id = await create("lightweight-admission-monitor");
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const observing = vi.spyOn(bot.core, "subscribe");
  const reading = vi.spyOn(bot.core, "openThread");
  const inspecting = vi.spyOn(bot.core, "recovery").mockResolvedValue({
    required: false,
    pending: true,
    queuedOnly: true,
    unsafeTool: false,
    blockedTasks: [],
  });
  provider.setResponses([
    () => {
      entered.resolve();
      return finish.promise;
    },
  ]);
  try {
    await bot.controller.submit(id, "Work", "lightweight-monitor");
    await entered.promise;
    expect(bot.controller.status().activeThreads).toContain(id);
    expect(observing).not.toHaveBeenCalled();
    await expect.poll(() => inspecting.mock.calls.length).toBeGreaterThan(0);
    expect(reading).not.toHaveBeenCalled();
    inspecting.mockRestore();
    finish.resolve(fauxAssistantMessage("Completed"));
    await expect.poll(() => bot.controller.status().activeThreads).toEqual([]);
    expect(observing).not.toHaveBeenCalled();
  } finally {
    finish.resolve(fauxAssistantMessage("Cleanup"));
    inspecting.mockRestore();
    reading.mockRestore();
    observing.mockRestore();
  }
});

test.each(["completed", "failed"] as const)(
  "an old recovery check (%s) cannot change a replacement admission",
  async (outcome) => {
    const { bot, provider, workspace, create } = await fixture();
    const id = await create(`old-check-${outcome}`);
    const other = await create(`competing-${outcome}`);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const modelEntered = Promise.withResolvers<void>();
    const finishModel = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let hold = false;
    // Drive monitor callbacks explicitly; native execution and all non-interval timers stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const controller = new BotController(
      {
        ...bot.core,
        recovery: async (threadId) => {
          const state = await bot.core.recovery(threadId);
          if (hold && threadId === id) {
            hold = false;
            entered.resolve();
            await release.promise;
            if (outcome === "failed") throw new Error("Old recovery inspection failed");
          }
          return state;
        },
      },
      new Map([[workspace, bot.workspaceProjects.get(workspace)!]]),
      2,
    );
    try {
      provider.setResponses([fauxAssistantMessage("First work completed")]);
      await controller.submit(id, "First work", "first-admission");
      await expect.poll(async () => (await bot.core.recovery(id)).pending).toBe(false);
      hold = true;
      const checking = vi.advanceTimersByTimeAsync(250);
      await entered.promise;
      await controller.stop(id);
      provider.setResponses([
        (_context, options) => {
          modelEntered.resolve();
          options?.signal?.addEventListener(
            "abort",
            () => finishModel.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
          return finishModel.promise;
        },
      ]);
      const replacement = await controller.submit(id, "Replacement work", "second-admission");
      await modelEntered.promise;
      release.resolve();
      await checking;
      await vi.advanceTimersByTimeAsync(0);
      expect((await bot.core.operation(id, replacement.operationId)).status).toBe("running");
      await expect(controller.submit(other, "Competing work", "competitor")).rejects.toMatchObject({
        code: "Busy",
      });
      expect(controller.status()).toEqual({
        activeThreads: [id],
        pendingRecovery: [],
        blocked: {},
      });
      finishModel.resolve(fauxAssistantMessage("Replacement completed"));
      await expect.poll(async () => (await bot.core.recovery(id)).pending).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      expect(controller.status().activeThreads).toEqual([]);
      await expect(controller.submit(other, "Competing work", "competitor")).resolves.toMatchObject(
        {
          kind: "run",
        },
      );
    } finally {
      release.resolve();
      finishModel.resolve(fauxAssistantMessage("Cleanup"));
      try {
        await controller.stop(id);
        await controller.stop(other);
        await controller.close(0);
      } finally {
        vi.useRealTimers();
      }
    }
  },
  15000,
);

test.each(["stopped", "during-stop", "stop-failed", "current"] as const)(
  "a %s recovery attempt only blocks its checkout while it still owns admission",
  async (attempt) => {
    const { bot, config, models, provider, create } = await fixture();
    const id = await create("interrupted-recovery");
    const other = await create("after-recovery-stop");
    let firstEntered = false;
    const firstModel = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    provider.setResponses([
      (_context, options) => {
        firstEntered = true;
        options?.signal?.addEventListener(
          "abort",
          () => firstModel.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return firstModel.promise;
      },
    ]);
    let core: Awaited<ReturnType<typeof createCore>> | undefined;
    let controller: BotController | undefined;
    let recovering: Promise<void> | undefined;
    let recoveryFinished = false;
    let resumedModelEntered = false;
    const resumedModel = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let resumeReturned = false;
    const failResume = Promise.withResolvers<void>();
    const stopEntered = Promise.withResolvers<void>();
    const finishStop = Promise.withResolvers<void>();
    let stopping: Promise<void> | undefined;
    let stopGated = false;
    try {
      await bot.controller.submit(id, "Interrupted work", "interrupted-input");
      await expect.poll(() => firstEntered, { timeout: 5000 }).toBe(true);
      await bot.close();
      core = await createCore({
        dataRoot: config.dataRoot,
        home: join(config.dataRoot, "home"),
        models,
        settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
        environment: { shutdown: "preserve" },
      });
      const client = core;
      expect((await client.recovery(id)).required).toBe(true);
      provider.setResponses([
        (_context, options) => {
          resumedModelEntered = true;
          options?.signal?.addEventListener(
            "abort",
            () => resumedModel.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
          return resumedModel.promise;
        },
      ]);
      controller = new BotController(
        {
          ...client,
          resume: async (threadId) => {
            await client.resume(threadId);
            resumeReturned = true;
            await failResume.promise;
            throw new Error("Recovery resume failed");
          },
          stop: async (threadId) => {
            if (
              threadId === id &&
              !stopGated &&
              (attempt === "during-stop" || attempt === "stop-failed")
            ) {
              stopGated = true;
              stopEntered.resolve();
              await finishStop.promise;
              if (attempt === "stop-failed") throw new Error("Core stop failed");
            }
            await client.stop(threadId);
          },
        },
        bot.workspaceProjects,
        2,
      );
      recovering = controller.recover();
      void recovering.then(() => {
        recoveryFinished = true;
      });
      await expect.poll(() => resumeReturned, { timeout: 5000 }).toBe(true);
      await expect.poll(() => resumedModelEntered, { timeout: 5000 }).toBe(true);
      if (attempt === "stopped") {
        await controller.stop(id);
        expect((await client.recovery(id)).pending).toBe(false);
      }
      if (attempt === "during-stop" || attempt === "stop-failed") {
        stopping = controller.stop(id);
        await stopEntered.promise;
        failResume.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(recoveryFinished).toBe(false);
        expect(controller.status().activeThreads).toContain(id);
        expect(controller.status().blocked[id]).toBeUndefined();
        await expect(controller.submit(other, "New work", "during-stop")).rejects.toMatchObject({
          code: "Busy",
        });
        finishStop.resolve();
        if (attempt === "stop-failed") {
          await expect(stopping).rejects.toThrow("Core stop failed");
          await recovering;
          expect(controller.status().blocked[id]).toBe("Recovery resume failed");
          expect(controller.status().activeThreads).not.toContain(id);
          await expect(controller.submit(other, "New work", "stop-failed")).rejects.toMatchObject({
            code: "Busy",
          });
          await controller.stop(id);
        } else {
          await stopping;
          await recovering;
          expect((await client.recovery(id)).pending).toBe(false);
        }
      }
      failResume.resolve();
      await recovering;
      if (attempt === "current") {
        expect(controller.status().blocked[id]).toBe("Recovery resume failed");
        await expect(controller.submit(other, "New work", "after-stop")).rejects.toMatchObject({
          code: "Busy",
        });
        await controller.stop(id);
      }
      provider.setResponses([fauxAssistantMessage("Checkout available")]);
      await expect(controller.submit(other, "New work", "after-stop")).resolves.toMatchObject({
        kind: "run",
      });
      expect(controller.status().blocked).toEqual({});
      await controller.stop(other);
    } finally {
      firstModel.resolve(fauxAssistantMessage("Cleanup"));
      resumedModel.resolve(fauxAssistantMessage("Cleanup"));
      failResume.resolve();
      finishStop.resolve();
      await recovering;
      await stopping?.catch(() => {});
      await controller?.close(0);
      await core?.close();
    }
  },
  30000,
);

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

test.each(["thread", "schedules"])(
  "idle %s SSE sends transport heartbeats without new model output",
  async (kind) => {
    const { bot, create } = await fixture();
    const id = await create("heartbeat-" + kind);
    const controller = new AbortController();
    vi.useFakeTimers();
    const response = await bot.app.request(
      kind === "thread" ? "/v1/threads/" + id + "/events" : "/v1/schedules/events",
      {
        headers: { authorization: "Bearer test-admin-token" },
        signal: controller.signal,
      },
    );
    const reader = response.body!.getReader();
    try {
      const initial = new TextDecoder().decode((await reader.read()).value);
      expect(initial).toContain("event: " + (kind === "thread" ? "snapshot" : "schedules"));
      const received: string[] = [];
      const pending = reader.read().then((value) => {
        received.push(new TextDecoder().decode(value.value));
      });
      await vi.advanceTimersByTimeAsync(15000);
      expect(received.join("")).toContain("event: heartbeat");
      await pending;
    } finally {
      controller.abort();
      await reader.cancel();
      vi.useRealTimers();
    }
  },
);

test("a self-referential symlink in the workspace root does not break the catalog", async () => {
  const { bot, request, config } = await fixture();
  await bot.core.stopScheduler();
  await symlink("loop-entry", join(config.workspaceRoot, "loop-entry"));
  const catalog = await request("/v1/library");
  expect(catalog.status).toBe(200);
  expect(LibrarySchema.parse(await catalog.json()).projects).toHaveLength(1);
});

test("project folder creation discovers unrelated directories only after registration", async () => {
  const { bot, request, config } = await fixture(true);
  await bot.core.stopScheduler();
  await mkdir(join(config.workspaceRoot, "unrelated"));
  const paths: string[] = [];
  const register = bot.core.registerProject;
  const registration = vi.spyOn(bot.core, "registerProject").mockImplementation((path, ...args) => {
    paths.push(path);
    return register(path, ...args);
  });
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  try {
    const response = await request("/v1/projects", { name: "requested", requestId: "folder" });
    expect(response.status).toBe(201);
    const project = Schema.decodeUnknownSync(identity)(await response.json());
    expect(paths[0]).toBe(join(config.workspaceRoot, "requested"));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await readdir(config.workspaceRoot)).toEqual(
      expect.arrayContaining(["requested", "unrelated"]),
    );
    expect(await bot.core.projects()).toHaveLength(2);
    const [workspace] = await bot.core.workspaces(project.id);
    expect(bot.workspaceProjects.get(workspace!.id)).toBe(project.id);
  } finally {
    registration.mockRestore();
    refresh.mockRestore();
  }
});

test("invalid project folder names do not trigger directory discovery", async () => {
  const { bot, request, config } = await fixture(true);
  await bot.core.stopScheduler();
  await mkdir(join(config.workspaceRoot, "unrelated"));
  const registration = vi.spyOn(bot.core, "registerProject");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  try {
    for (const [index, name] of ["../outside", ".hidden", " whitespace ", "a/b"].entries())
      expect((await request("/v1/projects", { name, requestId: "invalid-" + index })).status).toBe(
        400,
      );
    expect(registration).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(await bot.core.projects()).toEqual([]);
  } finally {
    registration.mockRestore();
    refresh.mockRestore();
  }
});

test("project folder replay refreshes scope without repeating creation and preserves conflicts", async () => {
  const { bot, request, config } = await fixture(true);
  await bot.core.stopScheduler();
  const body = { name: "requested", requestId: "replay-folder" };
  const first = await request("/v1/projects", body);
  expect(first.status).toBe(201);
  const project = Schema.decodeUnknownSync(identity)(await first.json());
  await mkdir(join(config.workspaceRoot, "later"));
  const creation = vi.spyOn(BotProjects.prototype, "create");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  try {
    const replay = await request("/v1/projects", body);
    expect(replay.status).toBe(201);
    expect(Schema.decodeUnknownSync(identity)(await replay.json())).toEqual(project);
    expect(creation).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await bot.core.projects()).toHaveLength(2);
    expect((await request("/v1/projects", { ...body, name: "different" })).status).toBe(409);
    expect(await readdir(config.workspaceRoot)).not.toContain("different");
    expect(creation).not.toHaveBeenCalled();
  } finally {
    creation.mockRestore();
    refresh.mockRestore();
  }
});

async function projectRootSwitchFixture() {
  const context = await fixture(true);
  await context.bot.core.stopScheduler();
  const firstRoot = context.config.workspaceRoot + "-first";
  const nextRoot = context.config.workspaceRoot + "-next";
  await rename(context.config.workspaceRoot, firstRoot);
  await mkdir(nextRoot);
  await symlink(firstRoot, context.config.workspaceRoot, "dir");
  return { ...context, firstRoot, nextRoot };
}

test("cached project folder replies cannot reuse a previous root's permission", async () => {
  const { bot, request, config, nextRoot } = await projectRootSwitchFixture();
  const body = { name: "requested", requestId: "switched-folder" };
  const response = await request("/v1/projects", body);
  expect(response.status).toBe(201);
  const project = Schema.decodeUnknownSync(identity)(await response.json());
  expect([...bot.workspaceProjects.values()]).toContain(project.id);
  await rm(config.workspaceRoot);
  await symlink(nextRoot, config.workspaceRoot, "dir");
  const creation = vi.spyOn(BotProjects.prototype, "create");
  try {
    const denied = await request("/v1/projects", body);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
    expect(creation).not.toHaveBeenCalled();
    expect([...bot.workspaceProjects.values()]).not.toContain(project.id);
    expect(await readdir(nextRoot)).toEqual([]);
  } finally {
    creation.mockRestore();
  }
});

test("coalesced folder requests revalidate their own scope after the creator publishes", async () => {
  const { bot, request, config, firstRoot, nextRoot } = await projectRootSwitchFixture();
  const original = BotProjects.prototype.create;
  const release = Promise.withResolvers<void>();
  let entered = false;
  const creating = vi.spyOn(BotProjects.prototype, "create").mockImplementation(async function (
    this: BotProjects,
    ...args
  ) {
    const project = await original.apply(this, args);
    entered = true;
    await release.promise;
    return project;
  });
  const receipts = vi.spyOn(BotStore.prototype, "request");
  const body = { name: "requested", requestId: "coalesced-folder" };
  const owner = Promise.resolve(request("/v1/projects", body));
  let duplicate: Promise<Response> | undefined;
  try {
    await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
    duplicate = Promise.resolve(request("/v1/projects", body));
    await expect
      .poll(() => receipts.mock.calls.filter(([, id]) => id === body.requestId).length, {
        timeout: 5000,
      })
      .toBe(2);
    await rm(config.workspaceRoot);
    await symlink(nextRoot, config.workspaceRoot, "dir");
    release.resolve();
    const response = await duplicate;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "ProjectUnavailable" } });
    // The owner may finish before or after the replacement scope publishes; only the joiner
    // must not inherit an authorization refresh it never performed.
    expect([201, 403]).toContain((await owner).status);
    expect(creating).toHaveBeenCalledTimes(1);
    expect(await readdir(firstRoot)).toContain("requested");
    expect(await readdir(nextRoot)).toEqual([]);
    expect([...bot.workspaceProjects.values()]).toEqual([]);
  } finally {
    release.resolve();
    await owner.catch(() => {});
    await duplicate?.catch(() => {});
    creating.mockRestore();
    receipts.mockRestore();
  }
}, 15000);

test("a project request reading its body at shutdown rejects closed-store ingress", async () => {
  const { bot, config } = await fixture(true);
  const release = Promise.withResolvers<void>();
  let reading = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading = true;
        await release.promise;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              name: "late-folder",
              requestId: "late-body-at-shutdown",
            }),
          ),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init = {
    method: "POST",
    headers: { authorization: "Bearer " + config.adminToken, "content-type": "application/json" },
    body,
    duplex: "half" as const,
  };
  const pending = Promise.resolve(
    bot.app.request(new Request("http://localhost/v1/projects", init)),
  );
  try {
    // Zero buffering means a pull starts only when the authenticated handler reads the body.
    await expect.poll(() => reading, { timeout: 5000 }).toBe(true);
    await bot.close();
    release.resolve();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "RuntimeClosing" } });
    expect(await readdir(config.workspaceRoot)).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([pending]);
  }
}, 15000);

test("project folder creation retains authentication, size, input and shutdown guards", async () => {
  const { bot, request, config } = await fixture(true);
  await bot.core.stopScheduler();
  const creating = vi.spyOn(BotProjects.prototype, "create");
  const refresh = vi.spyOn(BotProjects.prototype, "refresh");
  try {
    expect((await bot.app.request("/v1/projects", { method: "POST", body: "{}" })).status).toBe(
      401,
    );
    expect(
      (
        await bot.app.request("/v1/projects", {
          method: "POST",
          headers: {
            authorization: "Bearer " + config.adminToken,
            "content-length": String(48 * 1024 * 1024 + 1),
          },
          body: "{}",
        })
      ).status,
    ).toBe(413);
    expect((await request("/v1/projects", {})).status).toBe(400);
    expect(creating).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    await bot.close();
    expect((await request("/v1/projects", { name: "closed", requestId: "closed" })).status).toBe(
      503,
    );
    expect(creating).not.toHaveBeenCalled();
  } finally {
    creating.mockRestore();
    refresh.mockRestore();
  }
});

test.each([undefined, "delta-v1", "unknown-version"])(
  "thread SSE negotiates %s without changing legacy clients",
  async (mode) => {
    const { bot, create } = await fixture();
    const id = await create("incremental-events");
    const baseline = await bot.core.openThread(id);
    const stop = vi.fn();
    let publish!: (value: SnapshotResponse) => void | Promise<void>;
    vi.spyOn(bot.core, "subscribe").mockImplementation(async (_id, next) => {
      publish = next;
      void next(baseline);
      return stop;
    });
    const abort = new AbortController();
    const response = await bot.app.request(`/v1/threads/${id}/events`, {
      headers: {
        authorization: "Bearer test-admin-token",
        ...(mode ? { "x-eta-snapshot": mode } : {}),
      },
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const frame = async () => {
      while (!pending.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before a complete frame");
        pending += decoder.decode(chunk.value, { stream: true });
      }
      const end = pending.indexOf("\n\n");
      const value = pending.slice(0, end);
      pending = pending.slice(end + 2);
      return value;
    };
    try {
      expect(await frame()).toContain("event: snapshot\n");
      const changed = { snapshot: { ...baseline.snapshot, compacting: true }, contextTokens: 99 };
      const write = publish(changed);
      const update = await frame();
      await write;
      expect(update).toContain(
        mode === "delta-v1" ? "event: snapshot-delta\n" : "event: snapshot\n",
      );
      const data = JSON.parse(update.split("data: ")[1]!);
      expect(data.contextTokens).toBe(99);
      expect(data.snapshot.compacting).toBe(true);
      if (mode === "delta-v1")
        expect(data.transcript).toEqual({
          prefix: baseline.snapshot.transcript.length,
          suffix: 0,
          insert: [],
        });
      else expect(data.snapshot.transcript).toEqual(baseline.snapshot.transcript);
    } finally {
      abort.abort();
      await reader.cancel();
    }
    await expect.poll(() => stop.mock.calls.length).toBe(1);
  },
  10000,
);

test("JSON numeric overflow in credential import cannot corrupt the next Bot startup", async () => {
  const { bot, config, request, open } = await fixture(true);
  expect(
    (
      await request("/v1/credentials/import", {
        credentials: { stable: { type: "api_key", key: "fake-stable-key" } },
      })
    ).status,
  ).toBe(200);
  const path = join(config.dataRoot, "credentials.json");
  const before = await readFile(path, "utf8");
  const response = await bot.app.request("/v1/credentials/import", {
    method: "POST",
    headers: { authorization: "Bearer " + config.adminToken, "content-type": "application/json" },
    body: '{"credentials":{"stable":{"type":"oauth","refresh":"fake-refresh","access":"fake-access","expires":1e400}}}',
  });
  const body: unknown = await response.json();
  const unchanged = (await readFile(path, "utf8")) === before;
  await bot.close();
  const reopened = await open().then(
    () => ({ opened: true }),
    (error: unknown) => ({
      opened: false,
      code: error instanceof Error && "code" in error ? error.code : undefined,
    }),
  );
  expect({ status: response.status, body, unchanged, reopened }).toEqual({
    status: 400,
    body: { error: { code: "InvalidInput", message: "认证格式无效" } },
    unchanged: true,
    reopened: { opened: true },
  });
}, 15000);

test.each([8000, undefined])(
  "Bot shutdown cancels HTTP subagent wait timeout=%s before draining ingress",
  async (timeoutMs) => {
    const { bot, provider, models, config, create, request, open } = await fixture();
    const id = await create("shutdown-wait");
    const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
    let started = false;
    provider.setResponses([
      (_context, options) => {
        started = true;
        options?.signal?.addEventListener(
          "abort",
          () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return answer.promise;
      },
    ]);
    const original = bot.core.subagent;
    let entered = false;
    let settled = false;
    const executing = vi.spyOn(bot.core, "subagent").mockImplementation((...args) => {
      const work = original(...args);
      if (args[1].action === "wait") {
        entered = true;
        void work.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
      }
      return work;
    });
    let pending: Promise<Response> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const children = await bot.controller.subagent(
        id,
        { action: "spawn", name: "worker", message: "Held work", wait: false },
        "shutdown-child",
      );
      await expect.poll(() => started, { timeout: 5000 }).toBe(true);
      const immediate = await request(`/v1/threads/${id}/subagent`, {
        command: { action: "wait", path: children[0]!.path, timeoutMs: 0 },
        requestId: "immediate-read",
      });
      expect(immediate.status).toBe(200);
      expect(await immediate.json()).toMatchObject([{ path: children[0]!.path }]);
      entered = false;
      settled = false;
      pending = Promise.resolve(
        request(`/v1/threads/${id}/subagent`, {
          command: {
            action: "wait",
            path: children[0]!.path,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
          requestId: "shutdown-read",
        }),
      );
      await expect.poll(() => entered, { timeout: 5000 }).toBe(true);
      expect(settled).toBe(false);
      expect((await bot.core.recovery(id)).pending).toBe(true);
      let closed = false;
      closing = bot.close();
      void closing.then(
        () => {
          closed = true;
        },
        () => {},
      );
      await expect.poll(() => closed, { timeout: 3000 }).toBe(true);
      await closing;
      await expect.poll(() => settled, { timeout: 2000 }).toBe(true);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "RuntimeClosing" } });
      const preserved = await createCore({
        dataRoot: config.dataRoot,
        home: config.home ?? join(config.dataRoot, "home"),
        models,
        settings: { read: Effect.succeed(config.runtime), subscribe: () => () => {} },
        environment: { shutdown: "preserve" },
      });
      try {
        const restored = await preserved.openThread(id);
        expect(restored.snapshot.recoveryRequired).toBe(true);
        expect(restored.snapshot.subagents).toHaveLength(1);
        expect(restored.snapshot.subagents![0]!.status).not.toBe("stopped");
      } finally {
        await preserved.close();
      }
      provider.setResponses([fauxAssistantMessage("Recovered")]);
      const reopened = await open();
      expect((await reopened.core.openThread(id)).id).toBe(id);
      await reopened.controller.stop(id);
    } finally {
      answer.resolve(fauxAssistantMessage("Cleanup"));
      // This explicit Core close only runs after the assertions: old Bot ordering can still terminate.
      await bot.core.close();
      await Promise.allSettled([...(pending ? [pending] : []), ...(closing ? [closing] : [])]);
      executing.mockRestore();
    }
  },
  15000,
);

test.each([
  ["metadata", false, false],
  ["metadata", true, false],
  ["subagent", false, false],
  ["subagent", true, false],
  ["schedule", false, false],
  ["schedule", true, false],
  ["metadata", false, true],
  ["metadata", true, true],
] as const)(
  "late %s body with declared length=%s malformed=%s cannot enter closed backends",
  async (kind, declared, malformed) => {
    const { bot, config, create } = await fixture();
    const id = await create("late-body-target");
    const payload =
      kind === "metadata"
        ? { action: "rename", title: "Too late" }
        : kind === "subagent"
          ? { command: { action: "list" }, requestId: "late-list" }
          : {
              name: "Too late",
              prompt: "No execution",
              rule: { type: "daily", time: "10:00", timeZone: "UTC" },
              requestId: "late-schedule",
            };
    const text = malformed ? "{" : JSON.stringify(payload);
    const bytes = new TextEncoder().encode(text);
    if (malformed) {
      const response = await bot.app.request(`/v1/threads/${id}/metadata`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.adminToken}`,
          "content-type": "application/json",
        },
        body: text,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "InvalidInput" } });
    }
    const release = Promise.withResolvers<void>();
    let reading = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading = true;
          await release.promise;
          controller.enqueue(bytes);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const suffix = kind === "schedule" ? "schedules" : kind;
    const pending = Promise.resolve(
      bot.app.request(
        new Request(`http://localhost/v1/threads/${id}/${suffix}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.adminToken}`,
            "content-type": "application/json",
            ...(declared ? { "content-length": String(bytes.length) } : {}),
          },
          body,
          duplex: "half",
        }),
      ),
    );
    let restore = () => {};
    try {
      await expect.poll(() => reading, { timeout: 5000 }).toBe(true);
      await bot.close();
      const late = !declared
        ? vi.spyOn(BotProjects.prototype, kind === "schedule" ? "refresh" : "refreshForThread")
        : kind === "schedule"
          ? vi.spyOn(bot.core, "threads")
          : kind === "metadata"
            ? vi.spyOn(bot.core, "renameThread")
            : vi.spyOn(bot.controller, "subagent");
      restore = () => late.mockRestore();
      release.resolve();
      const result = await pending.then(
        async (response) => ({
          status: response.status,
          code: Schema.decodeUnknownSync(
            Schema.Struct({ error: Schema.Struct({ code: Schema.String }) }),
          )(await response.json()).error.code,
        }),
        (error: unknown) => ({ status: "rejected", code: String(error) }),
      );
      expect({ ...result, calls: late.mock.calls.length }).toEqual({
        status: 503,
        code: "RuntimeClosing",
        calls: 0,
      });
    } finally {
      release.resolve();
      await pending.catch(() => {});
      restore();
    }
  },
  15000,
);
