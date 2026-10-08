import { dispatchCommand } from "../../../ipc.ts";
import type { DesktopApplication } from "../../../bootstrap.ts";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { processImage } from "../../../platform/images.ts";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry } from "@eta/agent";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Clock, Effect, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { DesktopCatalogService } from "../../catalog/index.ts";
import { desktopServices } from "../../layer.ts";
import { ModelCatalogService } from "../../models/index.ts";
import { ProjectService } from "../../projects/index.ts";
import { RuntimeRegistryService } from "../../runtime/index.ts";
import { DesktopSettingsService } from "../../settings/index.ts";
import { WorkspaceService } from "../../workspaces/index.ts";
import { ThreadService } from "../index.ts";
import { SkillsService } from "../../skills/index.ts";
import { TitleDoc, TITLE_TASK_KIND } from "../title.ts";

const directories: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(withImages = false) {
  const directory = await mkdtemp(join(tmpdir(), "eta-durable-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "eta-test",
    models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }, { id: "plain" }],
    tokensPerSecond: 1000,
  });
  const models = createModels();
  const titleProvider = fauxProvider({
    provider: "eta-test",
    models: provider.models,
    tokensPerSecond: 1000,
  });
  models.setProvider({
    ...provider.provider,
    streamSimple: (model, context, options) =>
      options?.sessionId?.endsWith(":title")
        ? titleProvider.provider.streamSimple(model, context, options)
        : provider.provider.streamSimple(model, context, options),
  });
  const reopen = () => {
    const runtime = ManagedRuntime.make(
      desktopServices(
        join(directory, "data"),
        ModelCatalogService.layerWith(models),
        withImages ? processImage : undefined,
        SkillsService.layerWith(directory),
      ),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = reopen();
  const projects = await runtime.runPromise(ProjectService);
  const project = await runtime.runPromise(projects.register({ rootPath: cwd }));
  const workspaces = await runtime.runPromise(WorkspaceService);
  const workspace = (await runtime.runPromise(workspaces.list(project.id)))[0]!;
  const threads = await runtime.runPromise(ThreadService);
  const registry = await runtime.runPromise(RuntimeRegistryService);
  return {
    directory,
    cwd,
    runtime,
    provider,
    titleProvider,
    models,
    reopen,
    threads,
    registry,
    workspace,
  };
}

function holdResponse(provider: ReturnType<typeof fauxProvider>, text: string) {
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  provider.setResponses([
    (_context, options) => {
      ready.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => {
          answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
        },
        { once: true },
      );
      return answer.promise;
    },
  ]);
  return { ready: ready.promise, release: () => answer.resolve(fauxAssistantMessage(text)) };
}

test("title generation runs beside the main answer using the thread's selected model and stays out of its transcript", async () => {
  const { runtime, threads, registry, workspace, provider, titleProvider } = await setup();
  const main = holdResponse(provider, "Implemented the requested change");
  let requestedModel: string | undefined;
  titleProvider.setResponses([
    (_context, options, _state, model) => {
      requestedModel = model.id;
      expect(options?.reasoning).toBeUndefined();
      expect(getCurrentTools(_context.messages)).toHaveLength(0);
      return fauxAssistantMessage("修复登录重定向");
    },
  ]);
  const catalog = await runtime.runPromise(DesktopCatalogService);
  const seen: string[] = [];
  const stop = catalog.subscribe(() => {
    void runtime.runPromise(catalog.read).then((state) => seen.push(state.threads[0]?.title ?? ""));
  });
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.configure(created.id, "eta-test", "two", "high"));
  await runtime.runPromise(threads.submit(created.id, "请修复登录后错误的重定向"));
  await main.ready;
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await expect
    .poll(async () => (await runtime.runPromise(threads.get(created.id))).title)
    .toBe("修复登录重定向");
  expect(requestedModel).toBe("two");
  expect(record.running).toBe(true);
  await expect.poll(() => seen.includes("修复登录重定向")).toBe(true);
  stop();
  expect(
    (await record.harness.usage(BACKGROUND_CONTEXT)).models["eta-test/two"]?.totalTokens,
  ).toBeGreaterThan(0);
  main.release();
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const snapshot = await runtime.runPromise(threads.open(created.id));
  expect(snapshot.snapshot.transcript).toHaveLength(2);
  expect(JSON.stringify(snapshot.snapshot.transcript)).not.toContain("修复登录重定向");
  expect(snapshot.thread.titleSource).toBe("generated");
});

test("title generation can use a separately configured provider and model", async () => {
  const { runtime, threads, registry, workspace, provider, models } = await setup();
  const titles = fauxProvider({
    provider: "titles",
    models: [{ id: "small" }],
    tokensPerSecond: 1000,
  });
  models.setProvider(titles.provider);
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({ titleModel: { provider: "titles", modelId: "small" } }),
  );
  let titleModel: string | undefined;
  titles.setResponses([
    (_context, _options, _state, model) => {
      titleModel = `${model.provider}/${model.id}`;
      return fauxAssistantMessage("添加搜索功能");
    },
  ]);
  provider.setResponses([fauxAssistantMessage("Done")]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "添加搜索功能"));
  await expect
    .poll(async () => (await runtime.runPromise(threads.get(created.id))).titleSource)
    .toBe("generated");
  expect(titleModel).toBe("titles/small");
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  expect((await record.conversation.agent(BACKGROUND_CONTEXT)).model?.provider).toBe("eta-test");
});

test.each([
  { blockImages: false, acceptsImages: true, expectedImages: 1 },
  { blockImages: true, acceptsImages: true, expectedImages: 0 },
  { blockImages: false, acceptsImages: false, expectedImages: 0 },
])(
  "title generation respects image settings and model capabilities: %j",
  async ({ blockImages, acceptsImages, expectedImages }) => {
    const { runtime, threads, registry, workspace, provider, models } = await setup(true);
    const titles = fauxProvider({
      provider: "titles",
      models: [{ id: "small", input: acceptsImages ? ["text", "image"] : ["text"] }],
      tokensPerSecond: 1000,
    });
    models.setProvider(titles.provider);
    const settings = await runtime.runPromise(DesktopSettingsService);
    await runtime.runPromise(
      settings.update({ blockImages, titleModel: { provider: "titles", modelId: "small" } }),
    );
    const image = await processImage(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
        "base64",
      ),
      "shot.png",
    );
    let imageCount: number | undefined;
    titles.setResponses([
      (context) => {
        imageCount = context.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
          .filter((part) => part.type === "image").length;
        return fauxAssistantMessage("修复截图中的布局");
      },
    ]);
    provider.setResponses([fauxAssistantMessage("Done")]);
    const created = await runtime.runPromise(threads.create(workspace.id));
    await runtime.runPromise(
      threads.submit(created.id, "修复截图中的布局", "image-title", [image]),
    );
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    const state = await record.harness.snapshot(
      TitleDoc,
      record.conversation.id,
      BACKGROUND_CONTEXT,
    );
    expect(
      (await record.harness.waitForTask(state!.taskId!, BACKGROUND_CONTEXT)).state.outcome.status,
    ).toBe("completed");
    expect(imageCount).toBe(expectedImages);
  },
);

test("an unavailable title model keeps the temporary title while the main answer completes", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({ titleModel: { provider: "removed", modelId: "missing" } }),
  );
  provider.setResponses([fauxAssistantMessage("Done")]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "Keep this request"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const state = await record.harness.snapshot(TitleDoc, record.conversation.id, BACKGROUND_CONTEXT);
  expect(
    (await record.harness.waitForTask(state!.taskId!, BACKGROUND_CONTEXT)).state.outcome.status,
  ).toBe("failed");
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const opened = await runtime.runPromise(threads.open(created.id));
  expect(opened.thread.title).toBe("Keep this request");
  expect(opened.snapshot.lastResult?.status).toBe("completed");
  expect(opened.snapshot.faulted).toBe(false);
});

test("title generation never overwrites a manual rename even when it equals the temporary title", async () => {
  const { runtime, threads, registry, workspace, provider, titleProvider } = await setup();
  const title = holdResponse(titleProvider, "Generated title");
  provider.setResponses([fauxAssistantMessage("Done")]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "User request"));
  await title.ready;
  await runtime.runPromise(threads.rename(created.id, "User request"));
  title.release();
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const state = await record.harness.snapshot(TitleDoc, record.conversation.id, BACKGROUND_CONTEXT);
  await record.harness.waitForTask(state!.taskId!, BACKGROUND_CONTEXT);
  expect(await runtime.runPromise(threads.get(created.id))).toMatchObject({
    title: "User request",
    titleSource: "manual",
  });
});

test.each(["新会话", "My title"])(
  "title generation respects a name set before the first message: %s",
  async (name) => {
    const { runtime, threads, registry, workspace, provider, titleProvider } = await setup();
    provider.setResponses([fauxAssistantMessage("Done")]);
    const created = await runtime.runPromise(threads.create(workspace.id));
    await runtime.runPromise(threads.rename(created.id, name));
    await runtime.runPromise(threads.submit(created.id, "User request"));
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(titleProvider.state.callCount).toBe(0);
    expect(await runtime.runPromise(threads.get(created.id))).toMatchObject({
      title: name,
      titleSource: "manual",
    });
  },
);

test.each(["error", "empty"])(
  "title generation failure keeps the temporary title and does not repeat on later turns: %s",
  async (failure) => {
    const { runtime, threads, registry, workspace, provider, titleProvider } = await setup();
    titleProvider.setResponses([
      fauxAssistantMessage(
        "",
        failure === "error" ? { stopReason: "error", errorMessage: "Unavailable" } : {},
      ),
    ]);
    provider.setResponses([
      fauxAssistantMessage("First answer"),
      fauxAssistantMessage("Second answer"),
    ]);
    const created = await runtime.runPromise(threads.create(workspace.id));
    await runtime.runPromise(threads.submit(created.id, "First request"));
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    const state = await record.harness.snapshot(
      TitleDoc,
      record.conversation.id,
      BACKGROUND_CONTEXT,
    );
    const task = await record.harness.waitForTask(state!.taskId!, BACKGROUND_CONTEXT);
    expect(task.state.outcome.status).toBe("failed");
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => record.running).toBe(false);
    await runtime.runPromise(threads.submit(created.id, "Second request"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(titleProvider.state.callCount).toBe(1);
    const opened = await runtime.runPromise(threads.open(created.id));
    expect(opened.thread.title).toBe("First request");
    expect(opened.snapshot.faulted).toBe(false);
    expect(opened.snapshot.lastResult?.status).toBe("completed");
  },
);

test("title generation is admitted once when the first request is retried", async () => {
  const { runtime, threads, registry, workspace, provider, titleProvider } = await setup();
  const main = holdResponse(provider, "Done");
  titleProvider.setResponses([fauxAssistantMessage("One title")]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const first = await runtime.runPromise(
    Clock.clockWith((clock) =>
      threads.submit(created.id, "First request", "first").pipe(
        Effect.provideService(Clock.Clock, {
          currentTimeMillis: Effect.succeed(0),
          currentTimeMillisUnsafe: () => 0,
          currentTimeNanos: Effect.succeed(0n),
          currentTimeNanosUnsafe: () => 0n,
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) => clock.sleep(duration),
        }),
      ),
    ),
  );
  expect(first.startedAt).toBeGreaterThan(0);
  expect(await runtime.runPromise(threads.submit(created.id, "First request", "first"))).toEqual(
    first,
  );
  await expect.poll(() => titleProvider.state.callCount).toBe(1);
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  expect(
    (await record.storage.scanTasks({ kind: TITLE_TASK_KIND }, 10, undefined, BACKGROUND_CONTEXT))
      .items,
  ).toHaveLength(1);
  main.release();
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
});

test("stopping a thread cancels its pending title without affecting its temporary name", async () => {
  const { runtime, threads, registry, workspace, provider, titleProvider } = await setup();
  const title = holdResponse(titleProvider, "Should not apply");
  const main = holdResponse(provider, "Should not finish");
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "Keep this name"));
  await Promise.all([title.ready, main.ready]);
  await runtime.runPromise(threads.stop(created.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const state = await record.harness.snapshot(TitleDoc, record.conversation.id, BACKGROUND_CONTEXT);
  expect(
    (await record.harness.waitForTask(state!.taskId!, BACKGROUND_CONTEXT)).state.outcome.status,
  ).toBe("aborted");
  expect(state?.title).toBeUndefined();
  expect((await runtime.runPromise(threads.get(created.id))).title).toBe("Keep this name");
});

test("title-only unfinished work resumes on reopen without requesting foreground recovery and keeps its pinned model", async () => {
  const { runtime, threads, registry, workspace, provider, titleProvider, reopen } = await setup();
  const title = holdResponse(titleProvider, "Interrupted title");
  provider.setResponses([fauxAssistantMessage("Done")]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.configure(created.id, "eta-test", "two", "off"));
  await runtime.runPromise(threads.submit(created.id, "Original request"));
  await title.ready;
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => record.running).toBe(false);
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({ titleModel: { provider: "eta-test", modelId: "plain" } }),
  );
  await record.harness.close(BACKGROUND_CONTEXT);
  await runtime.dispose();
  let requested: string | undefined;
  titleProvider.setResponses([
    (_context, _options, _state, model) => {
      requested = model.id;
      return fauxAssistantMessage("Restored title");
    },
  ]);
  const next = reopen();
  const nextThreads = await next.runPromise(ThreadService);
  const opened = await next.runPromise(nextThreads.open(created.id));
  expect(opened.snapshot.recoveryRequired).toBe(false);
  await expect
    .poll(async () => (await next.runPromise(nextThreads.get(created.id))).title)
    .toBe("Restored title");
  expect(requested).toBe("two");
});

test("a completed generated title survives restart and later messages without another title request", async () => {
  const { runtime, threads, registry, workspace, provider, titleProvider, reopen } = await setup();
  titleProvider.setResponses([fauxAssistantMessage("持久化会话标题")]);
  provider.setResponses([
    fauxAssistantMessage("First answer"),
    fauxAssistantMessage("Second answer"),
  ]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "Original request"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.harness.waitForIdle(BACKGROUND_CONTEXT);
  await expect
    .poll(async () => (await runtime.runPromise(threads.get(created.id))).title)
    .toBe("持久化会话标题");
  await runtime.dispose();
  const next = reopen();
  const nextThreads = await next.runPromise(ThreadService);
  expect((await next.runPromise(nextThreads.open(created.id))).thread.titleSource).toBe(
    "generated",
  );
  await next.runPromise(nextThreads.submit(created.id, "A different request"));
  const nextRegistry = await next.runPromise(RuntimeRegistryService);
  const nextRecord = await next.runPromise(nextRegistry.acquire(created.thread.sessionRef));
  await nextRecord.harness.waitForIdle(BACKGROUND_CONTEXT);
  expect((await next.runPromise(nextThreads.get(created.id))).title).toBe("持久化会话标题");
  expect(titleProvider.state.callCount).toBe(1);
});

test("model switches persist supported levels and send the same effort shown in the thread", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const requested: (SimpleStreamOptions["reasoning"] | undefined)[] = [];
  provider.setResponses(
    Array.from({ length: 3 }, () => (_context, options) => {
      requested.push(options?.reasoning);
      return fauxAssistantMessage("Received");
    }),
  );
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  for (const [modelId, level, expected] of [
    ["one", "max", "high"],
    ["plain", "high", "off"],
    ["two", "off", "off"],
  ] as const) {
    const configured = await runtime.runPromise(
      threads.configure(created.id, "eta-test", modelId, level),
    );
    expect(configured.snapshot.configuration.thinkingLevel).toBe(expected);
    expect(configured.model.thinkingLevels).toContain(expected);
    await runtime.runPromise(threads.submit(created.id, "Hello"));
    await record.harness.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => record.running).toBe(false);
  }
  expect(requested).toEqual(["high", undefined, undefined]);
  await runtime.dispose();
  const next = reopen();
  const restored = await next.runPromise(ThreadService);
  expect((await next.runPromise(restored.open(created.id))).snapshot.configuration).toEqual({
    model: { provider: "eta-test", modelId: "two" },
    thinkingLevel: "off",
  });
});

test("new threads clamp default effort even when only a provider default is configured", async () => {
  const { runtime, threads, workspace } = await setup();
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({ defaultProvider: "eta-test", defaultThinkingLevel: "xhigh" }),
  );
  const created = await runtime.runPromise(threads.create(workspace.id));
  expect(created.snapshot.configuration.thinkingLevel).toBe("high");
});

test("model-specific extended effort and required thinking work for both defaults and thread changes", async () => {
  const { runtime, threads, workspace, models } = await setup();
  const provider = fauxProvider({
    provider: "extended",
    models: [{ id: "one", reasoning: true }],
  }).provider;
  models.setProvider({
    ...provider,
    getModels: () =>
      provider.getModels().map((model) => ({
        ...model,
        thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
      })),
  });
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({
      defaultProvider: "extended",
      defaultModel: "one",
      defaultThinkingLevel: "off",
    }),
  );
  const created = await runtime.runPromise(threads.create(workspace.id));
  expect(created.snapshot.configuration.thinkingLevel).toBe("low");
  for (const level of ["xhigh", "max"] as const) {
    expect(
      (await runtime.runPromise(threads.configure(created.id, "extended", "one", level))).snapshot
        .configuration.thinkingLevel,
    ).toBe(level);
  }
  expect(
    (await runtime.runPromise(threads.configure(created.id, "eta-test", "one", "max"))).snapshot
      .configuration.thinkingLevel,
  ).toBe("high");
});

test("an existing runtime normalizes invalid effort before the next provider request", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.configure({ thinkingLevel: "max" }, BACKGROUND_CONTEXT);
  let reasoning: SimpleStreamOptions["reasoning"];
  provider.setResponses([
    (_context, options) => {
      reasoning = options?.reasoning;
      return fauxAssistantMessage("Received");
    },
  ]);
  await runtime.runPromise(threads.submit(created.id, "Hello"));
  await record.harness.waitForIdle(BACKGROUND_CONTEXT);
  expect(reasoning).toBe("high");
  expect((await record.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
});

test("reopening idle history repairs a legacy unsupported level before its next request", async () => {
  const { runtime, threads, registry, workspace, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.configure({ thinkingLevel: "max" }, BACKGROUND_CONTEXT);
  await runtime.dispose();
  const next = reopen();
  const restored = await next.runPromise(ThreadService);
  expect(
    (await next.runPromise(restored.open(created.id))).snapshot.configuration.thinkingLevel,
  ).toBe("high");
  const nextRegistry = await next.runPromise(RuntimeRegistryService);
  const saved = await next.runPromise(nextRegistry.acquire(created.thread.sessionRef));
  expect((await saved.conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel).toBe("high");
});

test("create → real tools → dispose → reopen retains transcript, run result and per-thread model", async () => {
  const { runtime, threads, registry, provider, cwd, workspace, reopen } = await setup();
  await writeFile(join(cwd, "example.txt"), "Durable file content");
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "example.txt" }, { id: "read-file" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Read completed"),
  ]);
  const created = await runtime.runPromise(threads.create(workspace.id, "create-once"));
  expect(await runtime.runPromise(threads.create(workspace.id, "create-once"))).toMatchObject({
    id: created.id,
  });
  await runtime.runPromise(threads.configure(created.id, "eta-test", "two", "high"));
  const admission = await runtime.runPromise(threads.submit(created.id, "Read the file"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const before = await runtime.runPromise(threads.open(created.id));
  expect(JSON.stringify(before.snapshot.transcript)).toContain("Durable file content");
  expect(before.snapshot.lastResult).toMatchObject({
    operationId: admission.operationId,
    status: "completed",
  });
  await runtime.dispose();
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  const restored = await next.runPromise(other.open(created.id));
  expect(restored.snapshot.transcript).toEqual(before.snapshot.transcript);
  expect(restored.snapshot.lastResult).toEqual(before.snapshot.lastResult);
  expect(restored.snapshot.configuration).toEqual(before.snapshot.configuration);
  expect(restored.model.id).toBe("two");
  expect(restored.snapshot.recoveryRequired).toBe(false);
});

test("simultaneous open shares a single runtime; unsubscribing does not delete history", async () => {
  const { runtime, threads, registry, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const records = await runtime.runPromise(
    Effect.all(
      Array.from({ length: 8 }, () => registry.acquire(created.thread.sessionRef)),
      { concurrency: "unbounded" },
    ),
  );
  expect(new Set(records).size).toBe(1);
  let first = 0;
  let second = 0;
  const off1 = await runtime.runPromise(
    threads.subscribe(
      created.id,
      () => first++,
      () => {},
    ),
  );
  const off2 = await runtime.runPromise(
    threads.subscribe(
      created.id,
      () => second++,
      () => {},
    ),
  );
  off1();
  const previous = first;
  await runtime.runPromise(threads.configure(created.id, "eta-test", "two", "off"));
  await expect.poll(() => second).toBeGreaterThan(1);
  expect(first).toBe(previous);
  off2();
  expect(await runtime.runPromise(threads.list())).toHaveLength(1);
});

test("provider requests retain a stable session header across messages and reopen, isolated per thread", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const headers: SimpleStreamOptions["headers"][] = [];
  provider.setResponses(
    Array.from({ length: 4 }, () => (_context, options) => {
      headers.push(options?.headers);
      return fauxAssistantMessage("Received");
    }),
  );
  const first = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(first.thread.sessionRef));
  for (const prompt of ["Hello", "Continue"]) {
    await runtime.runPromise(threads.submit(first.id, prompt));
    await record.harness.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => record.running).toBe(false);
  }
  await runtime.dispose();
  const next = reopen();
  const nextThreads = await next.runPromise(ThreadService);
  const nextRegistry = await next.runPromise(RuntimeRegistryService);
  await next.runPromise(nextThreads.submit(first.id, "After restart"));
  const restored = await next.runPromise(nextRegistry.acquire(first.thread.sessionRef));
  await restored.harness.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => restored.running).toBe(false);
  const second = await next.runPromise(nextThreads.create(workspace.id));
  await next.runPromise(nextThreads.submit(second.id, "Separate conversation"));
  const other = await next.runPromise(nextRegistry.acquire(second.thread.sessionRef));
  await other.harness.waitForIdle(BACKGROUND_CONTEXT);
  expect(headers).toEqual(
    [first, first, first, second].map((thread) => ({
      "x-opencode-session": thread.thread.sessionRef.metadata.id,
      "User-Agent": "eta-desktop",
    })),
  );
  expect(first.thread.sessionRef.metadata.id).not.toBe(second.thread.sessionRef.metadata.id);
});

test("missing credentials or cwd block execution but preserve readable history", async () => {
  const { runtime, threads, workspace, models, cwd } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  models.deleteProvider("eta-test");
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.blockedReason).toContain(
    "模型",
  );
  expect(
    await runtime.runPromise(Effect.flip(threads.submit(created.id, "Blocked"))),
  ).toMatchObject({ code: "ModelUnavailable" });
  await rename(cwd, `${cwd}-moved`);
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.blockedReason).toContain(
    "目录",
  );
});

test("corruption is isolated to one thread and never creates an empty replacement", async () => {
  const { runtime, threads, workspace, reopen } = await setup();
  const bad = await runtime.runPromise(threads.create(workspace.id));
  const good = await runtime.runPromise(threads.create(workspace.id));
  await runtime.dispose();
  const path = join(bad.thread.sessionRef.metadata.path, "main.jsonl");
  const original = await readFile(path, "utf8");
  await writeFile(path, `not-json\n${original}`);
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  expect(await next.runPromise(Effect.flip(other.open(bad.id)))).toMatchObject({
    code: "StorageCorrupt",
  });
  expect((await next.runPromise(other.list())).map((thread) => thread.id)).toContain(bad.id);
  expect((await next.runPromise(other.open(good.id))).id).toBe(good.id);
  expect(await readFile(path, "utf8")).toBe(`not-json\n${original}`);
  await next.runPromise(other.archive(bad.id, true));
  expect((await next.runPromise(other.list())).map((thread) => thread.id)).not.toContain(bad.id);
});

test("archive has an inverse and default changes never overwrite existing conversation settings", async () => {
  const { runtime, threads, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({
      defaultProvider: "eta-test",
      defaultModel: "two",
      defaultThinkingLevel: "high",
    }),
  );
  const next = await runtime.runPromise(threads.create(workspace.id));
  expect(next.model.id).toBe("two");
  expect((await runtime.runPromise(threads.open(created.id))).model.id).toBe("one");
  await runtime.runPromise(threads.archive(created.id, true));
  expect((await runtime.runPromise(threads.list())).map((thread) => thread.id)).not.toContain(
    created.id,
  );
  expect(await runtime.runPromise(Effect.flip(threads.submit(created.id, "No")))).toMatchObject({
    code: "InvalidInput",
  });
  await runtime.runPromise(threads.archive(created.id, false));
  expect((await runtime.runPromise(threads.list())).map((thread) => thread.id)).toContain(
    created.id,
  );
});

test("threads in the same cwd run independently and stopping one leaves the other running", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const one = await runtime.runPromise(threads.create(workspace.id));
  const two = await runtime.runPromise(threads.create(workspace.id));
  const first = holdResponse(provider, "First answer");
  await runtime.runPromise(threads.submit(one.id, "Start"));
  await first.ready;
  const second = holdResponse(provider, "Second answer");
  const admission = await runtime.runPromise(threads.submit(two.id, "Run beside the first"));
  await second.ready;
  expect((await runtime.runPromise(threads.open(one.id))).snapshot.operation).not.toBeNull();
  expect((await runtime.runPromise(threads.open(two.id))).snapshot.operation?.id).toBe(
    admission.operationId,
  );
  await runtime.runPromise(threads.stop(one.id));
  expect((await runtime.runPromise(threads.open(one.id))).snapshot.lastResult?.status).toBe(
    "aborted",
  );
  expect((await runtime.runPromise(threads.open(two.id))).snapshot.operation?.id).toBe(
    admission.operationId,
  );
  provider.setResponses([fauxAssistantMessage("Restarted first answer")]);
  await runtime.runPromise(threads.submit(one.id, "Restart while the second is running"));
  const firstRuntime = await runtime.runPromise(registry.acquire(one.thread.sessionRef));
  await firstRuntime.harness.waitForIdle(BACKGROUND_CONTEXT);
  expect((await runtime.runPromise(threads.open(one.id))).snapshot.lastResult?.status).toBe(
    "completed",
  );
  second.release();
  const secondRuntime = await runtime.runPromise(registry.acquire(two.thread.sessionRef));
  await secondRuntime.harness.waitForIdle(BACKGROUND_CONTEXT);
  const finished = await runtime.runPromise(threads.open(two.id));
  expect(finished.snapshot.lastResult?.status).toBe("completed");
  expect(JSON.stringify(finished.snapshot.transcript)).toContain("Second answer");
  expect(JSON.stringify(finished.snapshot.transcript)).not.toContain("Restarted first answer");
});

test.each(["submit", "resume", "compact"] as const)(
  "%s cannot start another operation in a running thread",
  async (operation) => {
    const { runtime, threads, workspace, provider } = await setup();
    const created = await runtime.runPromise(threads.create(workspace.id));
    const answer = holdResponse(provider, "Answer");
    const admission = await runtime.runPromise(threads.submit(created.id, "Start"));
    await answer.ready;
    const rejected =
      operation === "submit"
        ? threads.submit(created.id, "Duplicate")
        : threads[operation](created.id);
    expect(await runtime.runPromise(Effect.flip(rejected))).toMatchObject({
      code: "Busy",
      message: "此会话已有任务运行，请等待或停止该任务",
    });
    const opened = await runtime.runPromise(threads.open(created.id));
    expect(opened.snapshot.operation?.id).toBe(admission.operationId);
    expect(
      opened.snapshot.transcript.filter((entry) => entry.message.role === "user"),
    ).toHaveLength(1);
    await runtime.runPromise(threads.stop(created.id));
  },
);

test.each(["compact", "stop"] as const)(
  "%s in an idle thread does not block or stop another thread in the same cwd",
  async (operation) => {
    const { runtime, threads, registry, workspace, provider } = await setup();
    const one = await runtime.runPromise(threads.create(workspace.id));
    const two = await runtime.runPromise(threads.create(workspace.id));
    const first = holdResponse(provider, "First answer");
    const admission = await runtime.runPromise(threads.submit(one.id, "Keep running"));
    await first.ready;
    await runtime.runPromise(threads[operation](two.id));
    const secondRuntime = await runtime.runPromise(registry.acquire(two.thread.sessionRef));
    await secondRuntime.harness.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => secondRuntime.running).toBe(false);
    expect((await runtime.runPromise(threads.open(one.id))).snapshot.operation?.id).toBe(
      admission.operationId,
    );
    provider.setResponses([fauxAssistantMessage("Second answer")]);
    await runtime.runPromise(threads.submit(two.id, "Run after the operation"));
    await secondRuntime.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect((await runtime.runPromise(threads.open(two.id))).snapshot.lastResult?.status).toBe(
      "completed",
    );
    await runtime.runPromise(threads.stop(one.id));
  },
);

test("retrying an admitted request returns its receipt rather than launching another run", async () => {
  const { runtime, threads, workspace, provider, reopen, titleProvider } = await setup();
  provider.setResponses([fauxAssistantMessage("Still running ".repeat(200))]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const first = await runtime.runPromise(threads.submit(created.id, "Only once", "input-once"));
  const repeated = await runtime.runPromise(threads.submit(created.id, "Only once", "input-once"));
  expect(repeated).toEqual(first);
  await runtime.runPromise(threads.stop(created.id));
  expect(
    (await runtime.runPromise(threads.open(created.id))).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ),
  ).toHaveLength(1);
  await runtime.dispose();
  const next = reopen();
  const nextThreads = await next.runPromise(ThreadService);
  const titleCalls = titleProvider.state.callCount;
  const providerCalls = provider.state.callCount;
  expect(await next.runPromise(nextThreads.submit(created.id, "Only once", "input-once"))).toEqual(
    first,
  );
  expect(provider.state.callCount).toBe(providerCalls);
  expect(titleProvider.state.callCount).toBe(titleCalls);
});

test("failed Catalog publication releases the runtime and preserves the orphan in recovery storage", async () => {
  const { directory, runtime, threads, workspace } = await setup();
  const catalogPath = join(directory, "data", "catalog.json");
  await rename(catalogPath, `${catalogPath}.original`);
  await mkdir(catalogPath);
  expect(await runtime.runPromise(Effect.flip(threads.create(workspace.id)))).toMatchObject({
    _tag: "CatalogStorageError",
  });
  expect(await runtime.runPromise(threads.list())).toEqual([]);
  const trash = join(directory, "data", "sessions", ".trash");
  const recovered = await readdir(trash);
  expect(recovered).toHaveLength(1);
  expect(await readFile(join(trash, recovered[0]!, "main.jsonl"), "utf8")).toContain("pi.agent");
  await rm(catalogPath, { recursive: true });
  await rename(`${catalogPath}.original`, catalogPath);
  expect((await runtime.runPromise(threads.create(workspace.id))).thread.workspaceId).toBe(
    workspace.id,
  );
});

test("an unavailable configured default fails before creating any thread or session directory", async () => {
  const { directory, runtime, threads, workspace } = await setup();
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(
    settings.update({ defaultProvider: "removed-provider", defaultModel: "missing" }),
  );
  expect(await runtime.runPromise(Effect.flip(threads.create(workspace.id)))).toMatchObject({
    code: "ModelUnavailable",
  });
  expect(await runtime.runPromise(threads.list())).toEqual([]);
  await expect(readdir(join(directory, "data", "sessions"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("workspaces canonicalize registration, retain unavailable records and reject execution in moved directories", async () => {
  const { directory, cwd, runtime, workspace } = await setup();
  const workspaces = await runtime.runPromise(WorkspaceService);
  expect(
    await runtime.runPromise(workspaces.register(workspace.projectId, join(cwd, "."))),
  ).toEqual(workspace);
  const checkout = join(directory, "existing-checkout");
  await mkdir(checkout);
  const extra = await runtime.runPromise(workspaces.register(workspace.projectId, checkout));
  expect(extra.kind).toBe("worktree");
  expect(await runtime.runPromise(workspaces.list(workspace.projectId))).toHaveLength(2);
  await rm(checkout, { recursive: true });
  expect(await runtime.runPromise(workspaces.get(extra.id))).toEqual(extra);
  expect(await runtime.runPromise(Effect.flip(workspaces.validate(extra.id)))).toMatchObject({
    code: "WorkspaceUnavailable",
  });
  expect(
    await runtime.runPromise(Effect.flip(workspaces.register("missing-project", cwd))),
  ).toMatchObject({ code: "NotFound" });
});

test("project instructions are captured for new conversations without rewriting saved instructions", async () => {
  const { cwd, runtime, threads, registry, workspace } = await setup();
  await writeFile(join(cwd, "AGENTS.md"), "Always run focused tests.");
  const first = await runtime.runPromise(threads.create(workspace.id));
  const one = await runtime.runPromise(registry.acquire(first.thread.sessionRef));
  expect((await one.conversation.agent(BACKGROUND_CONTEXT)).instructions).toContain(
    "Always run focused tests.",
  );
  await writeFile(join(cwd, "AGENTS.md"), "New instructions.");
  const second = await runtime.runPromise(threads.create(workspace.id));
  const two = await runtime.runPromise(registry.acquire(second.thread.sessionRef));
  expect((await two.conversation.agent(BACKGROUND_CONTEXT)).instructions).toContain(
    "New instructions.",
  );
  expect((await one.conversation.agent(BACKGROUND_CONTEXT)).instructions).toContain(
    "Always run focused tests.",
  );
});

test("context compaction never hides earlier chat history or displays an internal summary as user input", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  provider.setResponses([
    fauxAssistantMessage("First answer"),
    fauxAssistantMessage("Second answer"),
  ]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await runtime.runPromise(threads.submit(created.id, "Long earlier history ".repeat(200)));
  await record.harness.waitForIdle(BACKGROUND_CONTEXT);
  await expect.poll(() => record.running).toBe(false);
  await runtime.runPromise(threads.submit(created.id, "Latest input"));
  await record.harness.waitForIdle(BACKGROUND_CONTEXT);
  const before = await runtime.runPromise(threads.open(created.id));
  const entries = (
    await record.conversation.entries({}, 20, undefined, BACKGROUND_CONTEXT)
  ).items.toReversed();
  const firstKept = entries.filter((entry) =>
    entry.model?.some((message) => message.role === "user"),
  )[1]!.id;
  await record.conversation.commit(
    (tx) =>
      tx.appendEntry(record.conversation.id, {
        kind: CompactionEntry.kind,
        head: firstKept,
        model: [{ role: "user", content: "Internal summary", timestamp: 1 }],
      }),
    BACKGROUND_CONTEXT,
  );
  const after = await runtime.runPromise(threads.open(created.id));
  expect(after.snapshot.transcript).toEqual(before.snapshot.transcript);
  expect(after.contextTokens).toBeLessThan(before.contextTokens);
  expect(after.snapshot.lastResult).toEqual(before.snapshot.lastResult);
});

test("opening admitted unfinished work is paused until explicit resume", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  // Harness.close preserves durable receipts; desktop shutdown normally aborts its supervised runs.
  await record.harness.commit(
    (tx) =>
      tx.createSubmission({
        conversationId: record.conversation.id,
        type: "input",
        status: "queued",
        requestId: "survived-crash",
      }),
    BACKGROUND_CONTEXT,
  );
  await runtime.dispose();
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  const opened = await next.runPromise(other.open(created.id));
  expect(opened.snapshot.recoveryRequired).toBe(true);
  const nextRegistry = await next.runPromise(RuntimeRegistryService);
  const recovered = await next.runPromise(nextRegistry.acquire(created.thread.sessionRef));
  expect((await recovered.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
  expect(
    await next.runPromise(Effect.flip(other.submit(created.id, "Don't implicitly resume"))),
  ).toMatchObject({ code: "RecoveryRequired" });
  await next.runPromise(other.stop(created.id));
  expect((await next.runPromise(other.open(created.id))).snapshot.recoveryRequired).toBe(false);
  void provider;
});

test("session storage identity cannot be redirected outside AppPaths", async () => {
  const { runtime, threads, workspace, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const catalog = await runtime.runPromise(DesktopCatalogService);
  await runtime.runPromise(
    catalog.update((state) => ({
      ...state,
      threads: state.threads.map((thread) => ({
        ...thread,
        sessionRef: {
          ...thread.sessionRef,
          metadata: { ...thread.sessionRef.metadata, path: "/tmp/unowned" },
        },
      })),
    })),
  );
  await runtime.dispose();
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  expect(await next.runPromise(Effect.flip(other.open(created.id)))).toMatchObject({
    code: "StorageCorrupt",
  });
});

test("SIGKILL during streaming reopens paused and explicit resume settles the same input", async () => {
  const { directory, cwd, runtime, reopen, provider } = await setup();
  await runtime.dispose();
  const child = fork(
    new URL("./crash-worker.ts", import.meta.url),
    [join(directory, "data"), cwd],
    {
      execArgv: [
        "--experimental-strip-types",
        "--import",
        fileURLToPath(new URL("./source-loader.ts", import.meta.url)),
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString();
  });
  try {
    const crashed = await new Promise<{ thread: import("../type.ts").ThreadMetadata }>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Crash worker timed out: ${diagnostics}`)),
          8000,
        );
        child.once("message", (message) => {
          clearTimeout(timeout);
          resolve(message as { thread: import("../type.ts").ThreadMetadata });
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`Crash worker exited ${code}: ${diagnostics}`));
        });
      },
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const next = reopen();
    const threads = await next.runPromise(ThreadService);
    const opened = await next.runPromise(threads.open(crashed.thread.id));
    expect(opened.snapshot.recoveryRequired).toBe(true);
    const registry = await next.runPromise(RuntimeRegistryService);
    const record = await next.runPromise(registry.acquire(crashed.thread.sessionRef));
    expect((await record.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
    const other = await next.runPromise(threads.create(crashed.thread.workspaceId));
    const concurrent = holdResponse(provider, "Other thread answer");
    const admission = await next.runPromise(threads.submit(other.id, "Run during recovery"));
    await concurrent.ready;
    provider.setResponses([fauxAssistantMessage("Recovered final answer")]);
    await next.runPromise(threads.resume(crashed.thread.id));
    await record.harness.waitForIdle(BACKGROUND_CONTEXT);
    const final = await next.runPromise(threads.open(crashed.thread.id));
    expect(final.snapshot.recoveryRequired).toBe(false);
    expect(final.snapshot.lastResult?.status).toBe("completed");
    expect(final.snapshot.transcript.filter((entry) => entry.message.role === "user")).toHaveLength(
      1,
    );
    expect(JSON.stringify(final.snapshot.transcript)).toContain("Recovered final answer");
    expect((await next.runPromise(threads.open(other.id))).snapshot.operation?.id).toBe(
      admission.operationId,
    );
    concurrent.release();
    const otherRuntime = await next.runPromise(registry.acquire(other.thread.sessionRef));
    await otherRuntime.harness.waitForIdle(BACKGROUND_CONTEXT);
    expect((await next.runPromise(threads.open(other.id))).snapshot.lastResult?.status).toBe(
      "completed",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}, 15000);

test("normal shutdown settles a running tool, cleans its child process and preserves an aborted receipt", async () => {
  const { cwd, runtime, threads, registry, workspace, provider, reopen } = await setup();
  const pidPath = join(cwd, "child.pid");
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "bash",
        {
          command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000)'`,
        },
        { id: "long-process" },
      ),
      { stopReason: "toolUse" },
    ),
  ]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "Start a long-running tool"));
  await expect.poll(() => readFile(pidPath, "utf8").catch(() => "")).not.toBe("");
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).not.toThrow();
  await runtime.dispose();
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  const restored = await next.runPromise(other.open(created.id));
  expect(restored.snapshot.recoveryRequired).toBe(false);
  expect(restored.snapshot.lastResult?.status).toBe("aborted");
  void registry;
});

test("image attachments and read images survive restart; disabling reading only changes provider input", async () => {
  const { runtime, threads, registry, provider, cwd, workspace, reopen } = await setup(true);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(cwd, "shot.png"), bytes);
  const attachment = await processImage(bytes, "shot.png");
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(settings.update({ blockImages: true }));
  const requests: string[] = [];
  provider.setResponses([
    (context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(
        fauxToolCall("read", { path: "shot.png" }, { id: "read-image" }),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("Done");
    },
  ]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(created.id, "", "image-submit", [attachment]));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const before = await runtime.runPromise(threads.open(created.id));
  const user = before.snapshot.transcript.find((entry) => entry.message.role === "user");
  expect(user?.message.content).toEqual([
    { type: "image", data: attachment.data, mimeType: attachment.mimeType },
  ]);
  const result = before.snapshot.transcript.find((entry) => entry.message.role === "toolResult");
  expect(result?.message.content).toContainEqual({
    type: "image",
    data: attachment.data,
    mimeType: attachment.mimeType,
  });
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => !request.includes(attachment.data))).toBe(true);
  expect(requests[1]).toContain("Image reading is disabled.");
  await runtime.dispose();
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  expect((await next.runPromise(other.open(created.id))).snapshot.transcript).toEqual(
    before.snapshot.transcript,
  );
  const nextSettings = await next.runPromise(DesktopSettingsService);
  await next.runPromise(nextSettings.update({ blockImages: false }));
  provider.setResponses([
    (context) => {
      expect(JSON.stringify(context.messages)).toContain(attachment.data);
      return fauxAssistantMessage("Images restored");
    },
  ]);
  await next.runPromise(other.submit(created.id, "Read again"));
  const nextRegistry = await next.runPromise(RuntimeRegistryService);
  await (
    await next.runPromise(nextRegistry.acquire(created.thread.sessionRef))
  ).conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await next.runPromise(other.open(created.id))).snapshot.lastResult?.status).toBe(
    "completed",
  );
});

test("image admission enforces the selected model's attachment count before starting a run", async () => {
  const { runtime, threads, provider, workspace } = await setup(true);
  provider.getModel().inputLimits = { images: { maxPerMessage: 1 } };
  const created = await runtime.runPromise(threads.create(workspace.id));
  const image = {
    type: "image" as const,
    name: "shot.png",
    mimeType: "image/png",
    data: "aGVsbG8=",
  };
  expect(
    await runtime.runPromise(
      Effect.flip(threads.submit(created.id, "Describe", "too-many", [image, image])),
    ),
  ).toMatchObject({ code: "InvalidInput" });
  expect(provider.state.callCount).toBe(0);
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.transcript).toHaveLength(0);
});

test("tool toggles change the model catalog for an existing thread and reenabled tools execute", async () => {
  const { runtime, threads, registry, provider, cwd, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const settings = await runtime.runPromise(DesktopSettingsService);
  await writeFile(join(cwd, "available.txt"), "Reenabled read content");
  await runtime.runPromise(settings.update({ disabledTools: ["read", "bash"] }));
  provider.setResponses([
    (context) => {
      expect(
        getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["edit", "write"]);
      return fauxAssistantMessage("No file read");
    },
  ]);
  await runtime.runPromise(threads.submit(created.id, "First"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.lastResult?.status).toBe(
    "completed",
  );
  await runtime.runPromise(settings.update({ disabledTools: [] }));
  provider.setResponses([
    (context) => {
      expect(
        getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["bash", "edit", "read", "write"]);
      return fauxAssistantMessage(
        fauxToolCall("read", { path: "available.txt" }, { id: "reenabled" }),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Read succeeded"),
  ]);
  await runtime.runPromise(threads.submit(created.id, "Second"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(
    JSON.stringify((await runtime.runPromise(threads.open(created.id))).snapshot.transcript),
  ).toContain("Reenabled read content");
  await runtime.runPromise(settings.update({ disabledTools: ["read", "write", "edit", "bash"] }));
  provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages)).toEqual([]);
      return fauxAssistantMessage("All tools disabled");
    },
  ]);
  await runtime.runPromise(threads.submit(created.id, "Third"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.lastResult?.status).toBe(
    "completed",
  );
});

test("a disabled tool cannot execute even if a model emits its call", async () => {
  const { runtime, threads, registry, provider, cwd, workspace } = await setup();
  const settings = await runtime.runPromise(DesktopSettingsService);
  await runtime.runPromise(settings.update({ disabledTools: ["write"] }));
  const created = await runtime.runPromise(threads.create(workspace.id));
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "write",
        { path: "forbidden.txt", content: "Should not exist" },
        { id: "disabled-write" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Tool unavailable"),
  ]);
  await runtime.runPromise(threads.submit(created.id, "Attempt write"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await expect(readFile(join(cwd, "forbidden.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  const result = (await runtime.runPromise(threads.open(created.id))).snapshot.transcript.find(
    ({ message }) => message.role === "toolResult",
  );
  expect(result?.message).toMatchObject({ isError: true });
});

test("Electron submissions accept absent optional image fields and persist text and images", async () => {
  const { runtime, threads, registry, provider, workspace } = await setup(true);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const application = {
    submit: (
      id: string,
      prompt: string,
      requestId?: string,
      images?: Parameters<typeof threads.submit>[3],
    ) => runtime.runPromise(threads.submit(id, prompt, requestId, images)),
  } as DesktopApplication;
  provider.setResponses([
    fauxAssistantMessage("First response"),
    fauxAssistantMessage("Image response"),
  ]);
  await dispatchCommand(
    application,
    structuredClone({
      type: "submit",
      id: created.id,
      prompt: "Plain text",
      requestId: "ipc-text",
      images: undefined,
    }),
  );
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(
    (await runtime.runPromise(threads.open(created.id))).snapshot.transcript[0]?.message.content,
  ).toBe("Plain text");
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
  await dispatchCommand(
    application,
    structuredClone({
      type: "submit",
      id: created.id,
      prompt: "",
      requestId: "ipc-image",
      images: [{ type: "image", mimeType: "image/png", data, name: undefined, note: undefined }],
    }),
  );
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const users = (await runtime.runPromise(threads.open(created.id))).snapshot.transcript.filter(
    ({ message }) => message.role === "user",
  );
  expect(users).toHaveLength(2);
  expect(users[1]?.message.content).toEqual([{ type: "image", mimeType: "image/png", data }]);
});

test("project classification can move, ungroup and survive restart without changing execution identity", async () => {
  const { runtime, threads, workspace, directory, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const projects = await runtime.runPromise(ProjectService);
  const otherRoot = join(directory, "other-project");
  await mkdir(otherRoot);
  const project = await runtime.runPromise(projects.register({ rootPath: otherRoot }));
  const moved = await runtime.runPromise(threads.move(created.id, project.id));
  expect(moved.projectId).toBe(project.id);
  expect(moved.workspaceId).toBe(created.thread.workspaceId);
  expect(moved.sessionRef).toEqual(created.thread.sessionRef);
  await expect(Effect.runPromiseExit(threads.move(created.id, "missing"))).resolves.toMatchObject({
    _tag: "Failure",
  });
  await runtime.runPromise(threads.move(created.id, null));
  await runtime.dispose();
  const next = reopen();
  const restored = await next.runPromise(ThreadService);
  const opened = await next.runPromise(restored.open(created.id));
  expect(opened.thread.projectId).toBeNull();
  expect(opened.thread.sessionRef.metadata.cwd).toBe(created.thread.sessionRef.metadata.cwd);
  const identity = JSON.parse(
    await readFile(join(opened.thread.sessionRef.metadata.path, "identity.json"), "utf8"),
  );
  expect(identity.cwd).toBe(created.thread.sessionRef.metadata.cwd);
});

test("permanent removal closes the runtime and deletes only the selected session across restart", async () => {
  const { runtime, threads, registry, workspace, reopen } = await setup();
  const removed = await runtime.runPromise(threads.create(workspace.id));
  const kept = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(removed.thread.sessionRef));
  await runtime.runPromise(threads.remove(removed.id));
  expect(record.disposed).toBe(true);
  expect(await runtime.runPromise(threads.list(undefined, true))).toHaveLength(1);
  await expect(
    readFile(join(removed.thread.sessionRef.metadata.path, "identity.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await runtime.runPromise(threads.open(kept.id))).id).toBe(kept.id);
  await runtime.dispose();
  const next = reopen();
  const restored = await next.runPromise(ThreadService);
  expect(
    (await next.runPromise(restored.list(undefined, true))).map((thread) => thread.id),
  ).toEqual([kept.id]);
});

test("failed deletion publication restores the session directory and leaves it openable", async () => {
  const { directory, runtime, threads, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const path = join(directory, "data", "catalog.json");
  await rename(path, `${path}.original`);
  await mkdir(path);
  await expect(Effect.runPromiseExit(threads.remove(created.id))).resolves.toMatchObject({
    _tag: "Failure",
  });
  await expect(
    readFile(join(created.thread.sessionRef.metadata.path, "identity.json"), "utf8"),
  ).resolves.toContain(created.thread.sessionRef.metadata.id);
  await rm(path, { recursive: true });
  await rename(`${path}.original`, path);
  expect((await runtime.runPromise(threads.open(created.id))).id).toBe(created.id);
});

test("running and recovery-required threads cannot be permanently removed", async () => {
  const { runtime, threads, registry, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  record.running = true;
  await expect(Effect.runPromiseExit(threads.remove(created.id))).resolves.toMatchObject({
    _tag: "Failure",
  });
  record.running = false;
  record.recoveryRequired = true;
  await expect(Effect.runPromiseExit(threads.remove(created.id))).resolves.toMatchObject({
    _tag: "Failure",
  });
  record.recoveryRequired = false;
  expect((await runtime.runPromise(threads.get(created.id))).id).toBe(created.id);
});

test("corrupt and missing session data can still be permanently removed from the catalog", async () => {
  const { runtime, threads, workspace, reopen } = await setup();
  const corrupt = await runtime.runPromise(threads.create(workspace.id));
  const missing = await runtime.runPromise(threads.create(workspace.id));
  await writeFile(join(corrupt.thread.sessionRef.metadata.path, "identity.json"), "broken JSON");
  await runtime.runPromise(threads.remove(corrupt.id));
  await runtime.dispose();
  await rm(missing.thread.sessionRef.metadata.path, { recursive: true });
  const next = reopen();
  const restored = await next.runPromise(ThreadService);
  await next.runPromise(restored.remove(missing.id));
  expect(await next.runPromise(restored.list(undefined, true))).toEqual([]);
});
