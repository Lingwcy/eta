import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { processImage } from "@eta/core/node/images";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, defineTask } from "@eta/agent";
import { coreServices } from "../../../src/layer.ts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Clock, Effect, ManagedRuntime } from "effect";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { CatalogService } from "@eta/core/service/catalog/index";
import { testServices, TestSettings } from "../../support/runtime.ts";
import { ProjectService } from "@eta/core/service/projects/index";
import { RuntimeRegistryService } from "@eta/core/service/runtime/index";
import { WorkspaceService } from "@eta/core/service/workspaces/index";
import { ScheduleService } from "@eta/core/service/schedules/index";
import { ScheduleDispatcherService } from "@eta/core/service/schedules/dispatcher";
import { scheduleHostAdapter } from "@eta/core/service/schedules/host";
import { ThreadService } from "@eta/core/service/threads/index";
import { TitleDoc, TITLE_TASK_KIND } from "@eta/core/agent/extension/title/task";
import { defaultSubagentSettings } from "@eta/core/shared/subagents";
import { SubagentsDoc } from "@eta/core/agent/extension/subagent/index";

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
      testServices(
        join(directory, "data"),
        models,
        withImages ? processImage : undefined,
        directory,
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
  if (workspace.kind === "temporary") throw new Error("Expected a project workspace");
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

test.each([false, true])(
  "model configuration remains editable with a peer running and target running=%s",
  async (running) => {
    const { runtime, threads, registry, workspace, provider } = await setup();
    const peer = await runtime.runPromise(threads.create(workspace.id));
    const target = await runtime.runPromise(threads.create(workspace.id));
    const peerAnswer = holdResponse(provider, "Peer answer");
    const targetAnswer = running ? Promise.withResolvers<void>() : undefined;
    try {
      const peerAdmission = await runtime.runPromise(threads.submit(peer.id, "Peer work"));
      await peerAnswer.ready;
      let targetAdmission;
      if (targetAnswer) {
        const ready = Promise.withResolvers<void>();
        provider.setResponses([
          async (_context, options, _state, model) => {
            expect(model.id).toBe("one");
            ready.resolve();
            options?.signal?.addEventListener("abort", () => targetAnswer.resolve(), {
              once: true,
            });
            await targetAnswer.promise;
            return fauxAssistantMessage("Original answer");
          },
        ]);
        targetAdmission = await runtime.runPromise(threads.submit(target.id, "Target work"));
        await ready.promise;
      }
      const configured = await runtime.runPromise(
        threads.configure(target.id, "eta-test", "two", "high"),
      );
      expect(configured.snapshot.configuration).toMatchObject({
        model: { provider: "eta-test", modelId: "two" },
        thinkingLevel: "high",
      });
      expect(configured.snapshot.operation?.id).toBe(targetAdmission?.operationId);
      const peerState = await runtime.runPromise(threads.open(peer.id));
      expect(peerState.snapshot.operation?.id).toBe(peerAdmission.operationId);
      expect(peerState.snapshot.configuration.model.modelId).toBe("one");
      if (targetAnswer) {
        targetAnswer.resolve();
        const record = await runtime.runPromise(registry.acquire(target.thread.sessionRef));
        await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
        await expect.poll(() => record.running).toBe(false);
        const operation = await runtime.runPromise(
          threads.operation(target.id, targetAdmission!.operationId),
        );
        expect(operation.status).toBe("completed");
        expect(operation.messages[0]).toMatchObject({ model: "one" });
      }
      let requested: { model: string; reasoning: SimpleStreamOptions["reasoning"] } | undefined;
      provider.setResponses([
        (_context, options, _state, model) => {
          requested = { model: model.id, reasoning: options?.reasoning };
          return fauxAssistantMessage("New configuration");
        },
      ]);
      await runtime.runPromise(threads.submit(target.id, "Next request"));
      const record = await runtime.runPromise(registry.acquire(target.thread.sessionRef));
      await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
      expect(requested).toEqual({ model: "two", reasoning: "high" });
      expect((await runtime.runPromise(threads.open(peer.id))).snapshot.operation?.id).toBe(
        peerAdmission.operationId,
      );
    } finally {
      targetAnswer?.resolve();
      peerAnswer.release();
    }
  },
);

test.each(["rename", "stop"] as const)(
  "waiting for a subagent does not block %s behind the global mutation lock",
  async (action) => {
    const { runtime, threads, registry, workspace, provider } = await setup();
    const owner = await runtime.runPromise(threads.create(workspace.id));
    const other = await runtime.runPromise(threads.create(workspace.id));
    const record = await runtime.runPromise(registry.acquire(owner.thread.sessionRef));
    const execute = vi.spyOn(record.subagents, "execute");
    const held = holdResponse(provider, "Delegated work completed");
    let ready = false;
    void held.ready.then(() => {
      ready = true;
    });
    let waiting: Promise<unknown> | undefined;
    let mutation: Promise<unknown> | undefined;
    try {
      const children = await runtime.runPromise(
        threads.subagent(
          owner.id,
          {
            action: "spawn",
            name: "held",
            message: "Wait for release",
            wait: false,
          },
          "wait-lock-spawn",
        ),
      );
      const path = children[0]!.path;
      await expect.poll(() => ready, { timeout: 5000 }).toBe(true);
      let waitSettled = false;
      waiting = runtime.runPromise(
        threads.subagent(
          owner.id,
          {
            action: "wait",
            path,
            timeoutMs: 60000,
          },
          "wait-lock-read",
        ),
      );
      void waiting.then(
        () => {
          waitSettled = true;
        },
        () => {
          waitSettled = true;
        },
      );
      // The pass-through spy proves the wait entered Core, not merely that it was scheduled.
      await expect
        .poll(() => execute.mock.calls.some(([command]) => command.action === "wait"), {
          timeout: 5000,
        })
        .toBe(true);
      let changed = false;
      mutation =
        action === "rename"
          ? runtime.runPromise(threads.rename(other.id, "Changed while another thread waits"))
          : runtime.runPromise(threads.stop(owner.id));
      void mutation.then(
        () => {
          changed = true;
        },
        () => {
          changed = true;
        },
      );
      await expect.poll(() => changed, { timeout: 3000 }).toBe(true);
      await mutation;
      if (action === "rename") {
        expect((await runtime.runPromise(threads.get(other.id))).title).toBe(
          "Changed while another thread waits",
        );
        expect(waitSettled).toBe(false);
        expect((await runtime.runPromise(threads.recovery(owner.id))).pending).toBe(true);
        expect(
          await runtime.runPromise(Effect.flip(threads.archive(owner.id, true))),
        ).toMatchObject({ code: "Busy" });
        expect(waitSettled).toBe(false);
      } else {
        await waiting;
        expect((await runtime.runPromise(threads.recovery(owner.id))).pending).toBe(false);
      }
    } finally {
      held.release();
      await Promise.allSettled([...(waiting ? [waiting] : []), ...(mutation ? [mutation] : [])]);
      execute.mockRestore();
      await runtime.runPromise(threads.stop(owner.id));
    }
  },
  15000,
);

test("unlocked subagent waits retain timeout, target scope and archived-thread guards", async () => {
  const { runtime, threads, workspace, provider } = await setup();
  const owner = await runtime.runPromise(threads.create(workspace.id));
  const other = await runtime.runPromise(threads.create(workspace.id));
  const held = holdResponse(provider, "Delegated result");
  let ready = false;
  void held.ready.then(() => {
    ready = true;
  });
  try {
    const children = await runtime.runPromise(
      threads.subagent(
        owner.id,
        {
          action: "spawn",
          name: "held",
          message: "Hold this task",
          wait: false,
        },
        "wait-guards-spawn",
      ),
    );
    const path = children[0]!.path;
    await expect.poll(() => ready, { timeout: 5000 }).toBe(true);
    const command = { action: "wait" as const, path, timeoutMs: 0 };
    const deferred = threads.subagent(owner.id, command, "wait-command-snapshot");
    Object.assign(command, { action: "spawn", name: "unexpected", message: "Must not spawn" });
    expect(await runtime.runPromise(deferred)).toEqual([expect.objectContaining({ path })]);
    for (const timeoutMs of [0, 50]) {
      const result = await runtime.runPromise(
        threads.subagent(
          owner.id,
          {
            action: "wait",
            path,
            timeoutMs,
          },
          "wait-guards-" + timeoutMs,
        ),
      );
      expect(result).toEqual([expect.objectContaining({ path, status: "running" })]);
      expect((await runtime.runPromise(threads.recovery(owner.id))).pending).toBe(true);
    }
    await expect(
      runtime.runPromise(
        threads.subagent(
          owner.id,
          {
            action: "wait",
            path,
            timeoutMs: -1,
          },
          "wait-invalid-timeout",
        ),
      ),
    ).rejects.toThrow(/等待超时必须/);
    await expect(
      runtime.runPromise(
        threads.subagent(
          other.id,
          {
            action: "wait",
            path,
            timeoutMs: 0,
          },
          "wait-foreign-target",
        ),
      ),
    ).rejects.toThrow(/只能管理当前智能体的下级/);
    await runtime.runPromise(threads.archive(other.id, true));
    await expect(
      runtime.runPromise(
        threads.subagent(
          other.id,
          {
            action: "wait",
            path,
            timeoutMs: 0,
          },
          "wait-archived",
        ),
      ),
    ).rejects.toThrow(/归档会话需要先恢复/);
    expect((await runtime.runPromise(threads.recovery(owner.id))).pending).toBe(true);
  } finally {
    held.release();
    await runtime.runPromise(threads.stop(owner.id));
  }
}, 15000);

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
  const catalog = await runtime.runPromise(CatalogService);
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
}, 60_000);

test("title generation can use a separately configured provider and model", async () => {
  const { runtime, threads, registry, workspace, provider, models } = await setup();
  const titles = fauxProvider({
    provider: "titles",
    models: [{ id: "small" }],
    tokensPerSecond: 1000,
  });
  models.setProvider(titles.provider);
  const settings = await runtime.runPromise(TestSettings);
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
    const settings = await runtime.runPromise(TestSettings);
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
  const settings = await runtime.runPromise(TestSettings);
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
  const settings = await runtime.runPromise(TestSettings);
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
    agentMode: "standard",
    model: { provider: "eta-test", modelId: "two" },
    thinkingLevel: "off",
  });
});

test("new threads clamp default effort even when only a provider default is configured", async () => {
  const { runtime, threads, workspace } = await setup();
  const settings = await runtime.runPromise(TestSettings);
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
  const settings = await runtime.runPromise(TestSettings);
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
      () => {
        first++;
      },
      () => {},
    ),
  );
  const off2 = await runtime.runPromise(
    threads.subscribe(
      created.id,
      () => {
        second++;
      },
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

test("slow snapshot consumers coalesce updates without blocking other subscribers", async () => {
  const { runtime, threads, registry, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const slow: string[] = [];
  const fast: string[] = [];
  const errors: string[] = [];
  const stopSlow = await runtime.runPromise(
    threads.subscribe(
      created.id,
      async (value) => {
        slow.push(value.snapshot.configuration.model.modelId);
        if (slow.length === 1) {
          entered.resolve();
          await release.promise;
        }
      },
      (message) => {
        errors.push(message);
      },
    ),
  );
  const stopFast = await runtime.runPromise(
    threads.subscribe(
      created.id,
      (value) => {
        fast.push(value.snapshot.configuration.model.modelId);
      },
      (message) => {
        errors.push(message);
      },
    ),
  );
  try {
    await entered.promise;
    for (let index = 0; index < 20; index++) {
      const model = index % 2 ? "one" : "two";
      await runtime.runPromise(threads.configure(created.id, "eta-test", model, "off"));
      await expect.poll(() => fast.at(-1)).toBe(model);
    }
    await runtime.runPromise(threads.configure(created.id, "eta-test", "plain", "off"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await expect.poll(() => fast.at(-1)).toBe("plain");
    expect(slow).toHaveLength(1);
    release.resolve();
    await expect.poll(() => slow.at(-1)).toBe("plain");
    expect(slow).toHaveLength(2);
    expect(errors).toEqual([]);
  } finally {
    stopSlow();
    stopFast();
    release.resolve();
  }
});

test("unsubscribing a stalled snapshot consumer discards pending updates", async () => {
  const { runtime, threads, registry, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const initialWatches = record.watches.size;
  const initialChanges = record.changes.size;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const received: string[] = [];
  const errors: string[] = [];
  const stop = await runtime.runPromise(
    threads.subscribe(
      created.id,
      async (value) => {
        received.push(value.snapshot.configuration.model.modelId);
        entered.resolve();
        await release.promise;
        finished.resolve();
      },
      (message) => {
        errors.push(message);
      },
    ),
  );
  try {
    await entered.promise;
    await runtime.runPromise(threads.configure(created.id, "eta-test", "two", "off"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    stop();
    expect(record.watches.size).toBe(initialWatches);
    expect(record.changes.size).toBe(initialChanges);
    release.resolve();
    await finished.promise;
    await runtime.runPromise(threads.configure(created.id, "eta-test", "plain", "off"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(received).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    stop();
    release.resolve();
  }
});

test("rejected snapshot delivery reports an error and releases its subscription", async () => {
  const { runtime, threads, registry, workspace } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const initialWatches = record.watches.size;
  const initialChanges = record.changes.size;
  const entered = Promise.withResolvers<void>();
  const fail = Promise.withResolvers<void>();
  const errors: string[] = [];
  let deliveries = 0;
  const stop = await runtime.runPromise(
    threads.subscribe(
      created.id,
      async () => {
        deliveries++;
        entered.resolve();
        await fail.promise;
        throw new Error("receiver disconnected");
      },
      (message) => {
        errors.push(message);
      },
    ),
  );
  try {
    await entered.promise;
    await runtime.runPromise(threads.configure(created.id, "eta-test", "two", "off"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    fail.resolve();
    await expect.poll(() => errors).toEqual(["receiver disconnected"]);
    expect(record.watches.size).toBe(initialWatches);
    expect(record.changes.size).toBe(initialChanges);
    await runtime.runPromise(threads.configure(created.id, "eta-test", "plain", "off"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(deliveries).toBe(1);
  } finally {
    stop();
    fail.resolve();
  }
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
      "User-Agent": "eta-core-test",
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
  const settings = await runtime.runPromise(TestSettings);
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
  const settings = await runtime.runPromise(TestSettings);
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
  // Persist an input without starting it so shutdown cannot cancel it as foreground work.
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
  const configured = await next.runPromise(other.configure(created.id, "eta-test", "two", "high"));
  expect(configured.snapshot.configuration).toMatchObject({
    model: { provider: "eta-test", modelId: "two" },
    thinkingLevel: "high",
  });
  expect(configured.snapshot.recoveryRequired).toBe(true);
  expect((await recovered.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
  expect(
    await next.runPromise(Effect.flip(other.submit(created.id, "Still do not resume"))),
  ).toMatchObject({ code: "RecoveryRequired" });
  await next.runPromise(other.stop(created.id));
  expect((await next.runPromise(other.open(created.id))).snapshot.recoveryRequired).toBe(false);
  void provider;
});

test("session storage identity cannot be redirected outside AppPaths", async () => {
  const { runtime, threads, workspace, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const catalog = await runtime.runPromise(CatalogService);
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
    const crashed = await new Promise<{
      thread: import("@eta/core/shared/threads").ThreadMetadata;
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Crash worker timed out: ${diagnostics}`)),
        8000,
      );
      child.once("message", (message) => {
        clearTimeout(timeout);
        resolve(message as { thread: import("@eta/core/shared/threads").ThreadMetadata });
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Crash worker exited ${code}: ${diagnostics}`));
      });
    });
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

test.each(["shutdown", "delete"] as const)(
  "%s stops a native tool process before completing",
  async (action) => {
    const { cwd, runtime, threads, workspace, provider, reopen } = await setup();
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
    let pid = 0;
    try {
      await runtime.runPromise(threads.submit(created.id, "Start a long-running tool"));
      // Submission precedes model generation and native worker/child startup.
      await expect
        .poll(() => readFile(pidPath, "utf8").catch(() => ""), { timeout: 10_000 })
        .toMatch(/^\d+$/);
      pid = Number(await readFile(pidPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
      if (action === "delete") {
        await runtime.runPromise(threads.remove(created.id));
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 10_000 },
          )
          .toBe(false);
        expect(await runtime.runPromise(threads.list())).toEqual([]);
      }
    } finally {
      await runtime.dispose();
    }
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(false);
    const next = reopen();
    const other = await next.runPromise(ThreadService);
    if (action === "delete") {
      expect(await next.runPromise(other.list())).toEqual([]);
    } else {
      const restored = await next.runPromise(other.open(created.id));
      expect(restored.snapshot.recoveryRequired).toBe(false);
      expect(restored.snapshot.lastResult?.status).toBe("aborted");
    }
  },
  30_000,
);

test("image attachments and read images survive restart; disabling reading only changes provider input", async () => {
  const { runtime, threads, registry, provider, cwd, workspace, reopen } = await setup(true);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
    "base64",
  );
  await writeFile(join(cwd, "shot.png"), bytes);
  const attachment = await processImage(bytes, "shot.png");
  const settings = await runtime.runPromise(TestSettings);
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
  const nextSettings = await next.runPromise(TestSettings);
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
  const settings = await runtime.runPromise(TestSettings);
  await writeFile(join(cwd, "available.txt"), "Reenabled read content");
  await runtime.runPromise(settings.update({ disabledTools: ["read", "bash"] }));
  provider.setResponses([
    (context) => {
      expect(
        getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(["edit", "schedule", "subagent", "write"]);
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
      ).toEqual(["bash", "edit", "read", "schedule", "subagent", "write"]);
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
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
        "schedule",
        "subagent",
      ]);
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
  const settings = await runtime.runPromise(TestSettings);
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

test.each(["running", "recoveryRequired"] as const)(
  "deleting a %s thread stops and disposes it",
  async (state) => {
    const { runtime, threads, registry, workspace } = await setup();
    const created = await runtime.runPromise(threads.create(workspace.id));
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    record[state] = true;
    await runtime.runPromise(threads.remove(created.id));
    expect(record.disposed).toBe(true);
    expect(record.recoveryRequired).toBe(false);
    expect(await runtime.runPromise(threads.list())).toEqual([]);
  },
);

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

test("subagents expose their transcript and steering, preserve history on reopen, and keep root available", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  provider.setResponses(Array.from({ length: 15 }, () => fauxAssistantMessage("delegate answer")));
  await runtime.runPromise(
    threads.subagent(
      created.id,
      { action: "spawn", name: "review", message: "Inspect the code independently" },
      "spawn",
    ),
  );
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await expect.poll(async () => (await record.subagents.list())[0]?.status).toBe("completed");
  for (const task of (await record.harness.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (task.record.kind === "eta.subagent-reporter")
      await record.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
  }
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(
    JSON.stringify((await record.conversation.context(BACKGROUND_CONTEXT)).messages),
  ).toContain("[/review completed] delegate answer");
  const rootSnapshot = await runtime.runPromise(threads.open(created.id));
  expect(JSON.stringify(rootSnapshot.snapshot.transcript)).not.toContain("[/review completed]");
  expect(JSON.stringify(rootSnapshot.snapshot.transcript)).toContain("delegate answer");
  await runtime.runPromise(
    threads.subagent(
      created.id,
      { action: "spawn", name: "forked", fork: true, message: "Another task" },
      "forked",
    ),
  );
  await expect
    .poll(
      async () =>
        (await record.subagents.list()).find((child) => child.path === "/root/forked")?.status,
    )
    .toBe("completed");
  const forked = await runtime.runPromise(threads.openSubagent(created.id, "/root/forked"));
  expect(JSON.stringify(forked.snapshot.transcript)).not.toContain("[/review completed]");
  const child = await runtime.runPromise(threads.openSubagent(created.id, "/review"));
  expect(JSON.stringify(child.snapshot.transcript)).toContain("Inspect the code independently");
  expect(JSON.stringify(child.snapshot.transcript)).toContain("delegate answer");
  const revision = Promise.withResolvers<void>();
  const dispose = await runtime.runPromise(
    threads.subscribe(
      created.id,
      (value) => {
        if (JSON.stringify(value.snapshot.transcript).includes("Check the error handling too"))
          revision.resolve();
      },
      (message) => revision.reject(new Error(message)),
      "/review",
    ),
  );
  await runtime.runPromise(
    threads.subagent(
      created.id,
      { action: "send", path: "/review", message: "Check the error handling too" },
      "steer",
    ),
  );
  await revision.promise;
  dispose();
  await expect.poll(async () => (await record.subagents.list())[0]?.status).toBe("completed");
  for (const task of (await record.harness.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (task.record.kind === "eta.subagent-reporter")
      await record.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
  }
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await runtime.dispose();
  const next = reopen();
  const other = await next.runPromise(ThreadService);
  const restored = await next.runPromise(other.open(created.id));
  expect(restored.snapshot.subagents).toMatchObject([
    { path: "/review", status: "completed" },
    { path: "/root/forked", status: "completed" },
  ]);
  expect(JSON.stringify(restored.snapshot.transcript)).not.toContain("[/review completed]");
  expect(
    JSON.stringify(
      (await next.runPromise(other.openSubagent(created.id, "/root/forked"))).snapshot.transcript,
    ),
  ).not.toContain("[/review completed]");
  expect(
    JSON.stringify(
      (await next.runPromise(other.openSubagent(created.id, "/review"))).snapshot.transcript,
    ),
  ).toContain("Check the error handling too");
});

test("an orchestrator accepts new root messages and live child steering before a single final report", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const settings = await runtime.runPromise(TestSettings);
  await runtime.runPromise(
    settings.update({ subagents: { ...defaultSubagentSettings, mode: "orchestrator" } }),
  );
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let rootRequests = 0;
  provider.setResponses(
    Array.from({ length: 12 }, () => (request, options) => {
      const last = request.messages.findLast((message) => message.role === "user");
      if (last?.content === "research-work") {
        ready.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return answer.promise;
      }
      if (last?.content === "Verify official sources")
        return fauxAssistantMessage("Verified official source");
      rootRequests++;
      if (rootRequests === 1)
        return fauxAssistantMessage(
          [
            fauxToolCall("subagent", {
              action: "spawn",
              name: "research",
              message: "research-work",
              wait: false,
            }),
          ],
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(
        rootRequests === 2
          ? "Research is running"
          : rootRequests === 3
            ? "I will use official sources"
            : "Final verified summary",
      );
    }),
  );
  try {
    await runtime.runPromise(threads.submit(created.id, "Research this topic"));
    await ready.promise;
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await expect
      .poll(() =>
        runtime.runPromise(threads.open(created.id)).then((view) => view.snapshot.operation),
      )
      .toBeNull();
    expect(rootRequests).toBe(2);
    await runtime.runPromise(threads.submit(created.id, "Use official sources"));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(rootRequests).toBe(3);
    const child = (await record.subagents.list())[0]!;
    await record.subagents.execute(
      { action: "update", message: "Located an official notice; verification pending" },
      child.conversationId as typeof record.conversation.id,
      "progress",
    );
    expect(rootRequests).toBe(3);
    const working = await runtime.runPromise(threads.open(created.id));
    expect(working.snapshot.subagents).toMatchObject([
      {
        status: "running",
        progress: { message: "Located an official notice; verification pending" },
      },
    ]);
    expect(JSON.stringify(working.snapshot.transcript)).not.toContain("[/research progress]");
    await runtime.runPromise(
      threads.subagent(
        created.id,
        { action: "send", path: child.path, message: "Verify official sources" },
        "steer",
      ),
    );
    await expect
      .poll(async () =>
        (await record.harness.inspect(BACKGROUND_CONTEXT)).submissions.some(
          (receipt) => receipt.requestId === "subagent-steer:steer",
        ),
      )
      .toBe(true);
    answer.resolve(fauxAssistantMessage("Initial unverified source"));
    await record.subagents.wait(child.path, record.conversation.id, undefined, BACKGROUND_CONTEXT);
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(rootRequests).toBe(4);
    expect(
      JSON.stringify((await record.conversation.context(BACKGROUND_CONTEXT)).messages).match(
        /\[\/research completed\]/g,
      ),
    ).toHaveLength(1);
    expect((await record.subagents.list())[0]?.output).toBe("Verified official source");
    await runtime.dispose();
    const next = reopen();
    const restoredThreads = await next.runPromise(ThreadService);
    const restored = await next.runPromise(restoredThreads.open(created.id));
    expect(restored.snapshot.subagents).toMatchObject([
      {
        status: "completed",
        progress: { message: "Located an official notice; verification pending" },
        output: "Verified official source",
      },
    ]);
    expect(JSON.stringify(restored.snapshot.transcript)).not.toContain("[/research progress]");
    expect(JSON.stringify(restored.snapshot.transcript)).not.toContain("[/research completed]");
    expect(
      JSON.stringify(
        (await next.runPromise(restoredThreads.openSubagent(created.id, child.path))).snapshot
          .transcript,
      ),
    ).toContain("Verify official sources");
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
  }
});

test("resuming background subagents releases root input while their durable work continues", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const held = holdResponse(provider, "Initial result");
  await runtime.runPromise(
    threads.subagent(
      created.id,
      { action: "spawn", name: "worker", message: "long research" },
      "spawn",
    ),
  );
  await held.ready;
  const first = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const child = (await first.subagents.list())[0]!;
  await first.subagents.execute(
    { action: "update", message: "Found a source; verification pending" },
    child.conversationId as typeof first.conversation.id,
    "progress",
  );
  await runtime.dispose();
  const next = reopen();
  const restoredThreads = await next.runPromise(ThreadService);
  expect((await next.runPromise(restoredThreads.open(created.id))).snapshot.recoveryRequired).toBe(
    true,
  );
  const recovered = holdResponse(provider, "Recovered verified findings");
  await next.runPromise(restoredThreads.resume(created.id));
  await recovered.ready;
  const restoredRegistry = await next.runPromise(RuntimeRegistryService);
  const restored = await next.runPromise(restoredRegistry.acquire(created.thread.sessionRef));
  await expect.poll(() => restored.running).toBe(false);
  expect((await restored.subagents.list())[0]).toMatchObject({
    status: "running",
    progress: { message: "Found a source; verification pending" },
  });
  provider.setResponses([
    fauxAssistantMessage("New preference accepted"),
    fauxAssistantMessage("Final summary of recovered findings"),
  ]);
  await next.runPromise(restoredThreads.submit(created.id, "Use official sources"));
  await restored.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await restored.subagents.list())[0]?.status).toBe("running");
  recovered.release();
  await restored.subagents.wait(
    child.path,
    restored.conversation.id,
    undefined,
    BACKGROUND_CONTEXT,
  );
  await restored.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const final = await next.runPromise(restoredThreads.open(created.id));
  expect(JSON.stringify(final.snapshot.transcript)).toContain("Use official sources");
  expect(JSON.stringify(final.snapshot.transcript)).toContain(
    "Final summary of recovered findings",
  );
  expect(JSON.stringify(final.snapshot.transcript)).not.toContain("[/worker progress]");
});

test("recovers an interrupted subagent stop intent without cancelling unrelated work", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const settings = await runtime.runPromise(TestSettings);
  await runtime.runPromise(
    settings.update({ subagents: { ...defaultSubagentSettings, maxConcurrent: 1 } }),
  );
  const created = await runtime.runPromise(threads.create(workspace.id));
  const held = holdResponse(provider, "Parent result");
  await runtime.runPromise(
    threads.subagent(
      created.id,
      { action: "spawn", name: "parent", message: "long work", canDelegate: true },
      "parent",
    ),
  );
  await held.ready;
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const parent = (await record.subagents.list())[0]!;
  await record.subagents.execute(
    { action: "spawn", name: "descendant", message: "queued work" },
    parent.conversationId as typeof record.conversation.id,
    "descendant",
  );
  await record.subagents.execute(
    { action: "spawn", name: "unrelated", message: "other queued work" },
    record.conversation.id,
    "unrelated",
  );
  await record.conversation.commit(async (tx) => {
    const doc = await tx.doc(SubagentsDoc);
    for (const child of doc.agents) {
      if (child.path === "/parent" || child.path === "/descendant") child.stopping = true;
    }
  }, BACKGROUND_CONTEXT);
  await runtime.dispose();
  let resumedRequests = 0;
  provider.setResponses([
    () => {
      resumedRequests++;
      return fauxAssistantMessage("Must wait for explicit recovery");
    },
  ]);
  const next = reopen();
  const restoredThreads = await next.runPromise(ThreadService);
  await next.runPromise(restoredThreads.open(created.id));
  const restoredRegistry = await next.runPromise(RuntimeRegistryService);
  const restored = await next.runPromise(restoredRegistry.acquire(created.thread.sessionRef));
  expect((await restored.subagents.list()).map((child) => child.status)).toEqual([
    "stopped",
    "stopped",
    "queued",
  ]);
  expect(resumedRequests).toBe(0);
  expect(
    (await restored.harness.snapshot(SubagentsDoc, BACKGROUND_CONTEXT))?.agents.some(
      (child) => child.stopping,
    ),
  ).toBe(false);
});

test("parent cancellation exposes stopped child and tool states live and after reopening", async () => {
  const { runtime, threads, registry, workspace, provider, reopen } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const stopChild = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const childResponse = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let childRequested = false;
  let unsubscribe = () => {};
  let rootRequests = 0;
  provider.setResponses(
    Array.from({ length: 8 }, () => (request) => {
      if (
        request.messages.some(
          (message) => message.role === "user" && message.content === "child-work",
        )
      ) {
        childRequested = true;
        return childResponse.promise;
      }
      rootRequests++;
      if (rootRequests === 1)
        return fauxAssistantMessage(
          fauxToolCall("subagent", {
            action: "spawn",
            name: "worker",
            message: "child-work",
            wait: false,
          }),
          { stopReason: "toolUse" },
        );
      if (rootRequests === 2) return stopChild.promise;
      return fauxAssistantMessage("Final answer after cancelling redundant work");
    }),
  );
  try {
    await runtime.runPromise(threads.submit(created.id, "Investigate this"));
    await expect.poll(() => childRequested, { timeout: 10_000 }).toBe(true);
    const generating = await runtime.runPromise(threads.openSubagent(created.id, "/worker"));
    expect(generating.snapshot.operation?.runningTools).toEqual([]);
    childResponse.resolve(
      fauxAssistantMessage(
        fauxToolCall(
          "bash",
          { command: "printf 'partial child output\\n'; sleep 30" },
          { id: "child-bash" },
        ),
        { stopReason: "toolUse" },
      ),
    );
    await expect
      .poll(
        async () => {
          const child = await runtime.runPromise(threads.openSubagent(created.id, "/worker"));
          return child.snapshot.operation?.runningTools.some(
            (tool) => tool.toolCallId === "child-bash",
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const stopped = Promise.withResolvers<void>();
    unsubscribe = await runtime.runPromise(
      threads.subscribe(
        created.id,
        (value) => {
          if (
            value.snapshot.subagents?.some(
              (child) => child.path === "/worker" && child.status === "stopped",
            )
          )
            stopped.resolve();
        },
        (message) => stopped.reject(new Error(message)),
        "/worker",
      ),
    );
    stopChild.resolve(
      fauxAssistantMessage(fauxToolCall("subagent", { action: "stop", path: "/worker" }), {
        stopReason: "toolUse",
      }),
    );
    await stopped.promise;
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const child = await runtime.runPromise(threads.openSubagent(created.id, "/worker"));
    expect(child.snapshot.operation).toBeNull();
    expect(child.snapshot.lastResult?.status).toBe("aborted");
    expect(child.snapshot.subagents).toMatchObject([{ path: "/worker", status: "stopped" }]);
    expect(
      child.snapshot.transcript.find(
        ({ message }) => message.role === "toolResult" && message.toolCallId === "child-bash",
      ),
    ).toMatchObject({ toolStatus: "stopped" });
    expect((await runtime.runPromise(threads.open(created.id))).snapshot.lastResult?.status).toBe(
      "completed",
    );
  } finally {
    unsubscribe();
    childResponse.resolve(fauxAssistantMessage("done"));
    stopChild.resolve(fauxAssistantMessage("done"));
  }
  await runtime.dispose();
  const next = reopen();
  const restoredThreads = await next.runPromise(ThreadService);
  const restored = await next.runPromise(restoredThreads.openSubagent(created.id, "/worker"));
  expect(restored.snapshot.subagents).toMatchObject([{ path: "/worker", status: "stopped" }]);
  expect(
    restored.snapshot.transcript.find(
      ({ message }) => message.role === "toolResult" && message.toolCallId === "child-bash",
    ),
  ).toMatchObject({ toolStatus: "stopped" });
}, 30_000);

test("background delegates block archive while deletion stops their work", async () => {
  const { runtime, threads, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const held = holdResponse(provider, "delegate answer");
  await runtime.runPromise(
    threads.subagent(
      created.id,
      { action: "spawn", name: "worker", message: "Long task" },
      "spawn",
    ),
  );
  await held.ready;
  const view = await runtime.runPromise(threads.open(created.id));
  expect(view.snapshot.operation).toBeNull();
  expect(view.snapshot.subagents).toMatchObject([{ status: "running" }]);
  expect(await runtime.runPromise(Effect.flip(threads.archive(created.id, true)))).toMatchObject({
    code: "Busy",
  });
  await runtime.runPromise(threads.remove(created.id));
  expect(await runtime.runPromise(threads.list())).toEqual([]);
});

test("the subagent switch updates open threads, restores coding in orchestrator mode and survives reopening", async () => {
  const { runtime, threads, registry, workspace, provider, cwd, reopen } = await setup();
  const settings = await runtime.runPromise(TestSettings);
  const { enabled: _enabled, ...legacy } = defaultSubagentSettings;
  const policy = { ...legacy, mode: "orchestrator" as const };
  await runtime.runPromise(settings.update({ subagents: policy }));
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  provider.setResponses([
    (request) => {
      expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
        "subagent",
        "schedule",
      ]);
      expect(getCurrentSystemMessage(request.messages)?.sections?.subagents).toContain(
        "Delegate all",
      );
      return fauxAssistantMessage("Ready to delegate");
    },
    (request) => {
      const tools = getCurrentTools(request.messages).map((tool) => tool.name);
      expect(tools).not.toContain("subagent");
      expect(tools).toContain("write");
      expect(getCurrentSystemMessage(request.messages)?.sections?.subagents).toBeUndefined();
      return fauxAssistantMessage(
        fauxToolCall("write", { path: "switch.txt", content: "Coding restored" }),
        { stopReason: "toolUse" },
      );
    },
    (request) => {
      expect(request.messages.findLast((message) => message.role === "toolResult")?.isError).toBe(
        false,
      );
      return fauxAssistantMessage("Wrote the file");
    },
  ]);
  await runtime.runPromise(threads.submit(created.id, "Check enabled behavior"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await runtime.runPromise(settings.update({ subagents: { ...policy, enabled: false } }));
  await runtime.runPromise(threads.submit(created.id, "Write a file without delegating"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(await readFile(join(cwd, "switch.txt"), "utf8")).toBe("Coding restored");
  expect(
    await runtime.runPromise(
      Effect.flip(
        threads.subagent(created.id, { action: "spawn", message: "blocked" }, "disabled"),
      ),
    ),
  ).toMatchObject({ code: "InvalidInput" });
  await runtime.dispose();
  const next = reopen();
  const restoredThreads = await next.runPromise(ThreadService);
  const restoredRegistry = await next.runPromise(RuntimeRegistryService);
  const restoredSettings = await next.runPromise(TestSettings);
  const restored = await next.runPromise(restoredThreads.open(created.id));
  const restoredRecord = await next.runPromise(restoredRegistry.acquire(created.thread.sessionRef));
  expect(
    (await restoredRecord.conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
  ).not.toContain("subagent");
  expect(restored.snapshot.recoveryRequired).toBe(false);
  await next.runPromise(restoredSettings.update({ subagents: { ...policy, enabled: true } }));
  provider.setResponses([
    (request) => {
      expect(getCurrentTools(request.messages).map((tool) => tool.name)).toEqual([
        "subagent",
        "schedule",
      ]);
      expect(getCurrentSystemMessage(request.messages)?.sections?.subagents).toContain(
        "Delegate all",
      );
      return fauxAssistantMessage("Delegation restored");
    },
  ]);
  await next.runPromise(restoredThreads.submit(created.id, "Check reenabled behavior"));
  await restoredRecord.conversation.waitForIdle(BACKGROUND_CONTEXT);
});

test("disabling subagents lets an existing child finish and deliver its report", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const ready = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  provider.setResponses([
    (_request, options) => {
      ready.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => answer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        { once: true },
      );
      return answer.promise;
    },
    (request) => {
      expect(getCurrentTools(request.messages).map((tool) => tool.name)).not.toContain("subagent");
      expect(getCurrentSystemMessage(request.messages)?.sections?.subagents).toBeUndefined();
      expect(JSON.stringify(request.messages)).toContain(
        "[/worker completed] Finished original task",
      );
      return fauxAssistantMessage("Received the existing result");
    },
  ]);
  try {
    await runtime.runPromise(
      threads.subagent(
        created.id,
        { action: "spawn", name: "worker", message: "existing-work" },
        "spawn",
      ),
    );
    await ready.promise;
    const settings = await runtime.runPromise(TestSettings);
    await runtime.runPromise(
      settings.update({ subagents: { ...defaultSubagentSettings, enabled: false } }),
    );
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    await record.refreshTools();
    expect((await record.subagents.list())[0]?.status).toBe("running");
    const child = (await record.subagents.list())[0]!;
    const childConversation = (await record.harness.conversation(
      child.conversationId as typeof record.conversation.id,
      BACKGROUND_CONTEXT,
    ))!;
    expect(
      (await childConversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
    ).not.toContain("subagent");
    answer.resolve(fauxAssistantMessage("Finished original task"));
    await expect.poll(async () => (await record.subagents.list())[0]?.status).toBe("completed");
    for (const task of (await record.harness.inspect(BACKGROUND_CONTEXT)).tasks)
      if (task.record.kind === "eta.subagent-reporter")
        await record.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(
      JSON.stringify((await runtime.runPromise(threads.open(created.id))).snapshot.transcript),
    ).toContain("Received the existing result");
  } finally {
    answer.resolve(fauxAssistantMessage("done"));
  }
});

test("orchestrator root offers delegation and scheduling while children retain coding tools and configured presets", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const settings = await runtime.runPromise(TestSettings);
  await runtime.runPromise(
    settings.update({
      subagents: {
        mode: "orchestrator",
        maxDepth: 3,
        maxConcurrent: 2,
        allowedModels: [{ provider: "eta-test", modelId: "two" }],
        presets: [
          {
            name: "research",
            thinkingLevel: "high",
            instructions: "Research carefully",
            models: [
              { provider: "missing", modelId: "offline" },
              { provider: "eta-test", modelId: "two" },
            ],
          },
        ],
      },
    }),
  );
  const created = await runtime.runPromise(threads.create(workspace.id));
  provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual([
        "subagent",
        "schedule",
      ]);
      return fauxAssistantMessage(
        fauxToolCall(
          "subagent",
          { action: "spawn", name: "research", preset: "research", message: "Investigate" },
          { id: "spawn" },
        ),
        { stopReason: "toolUse" },
      );
    },
    ...Array.from({ length: 10 }, () => fauxAssistantMessage("answer")),
  ]);
  await runtime.runPromise(threads.submit(created.id, "Research this"));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  // A subagent needs a tool turn and at least one model stream; the implicit 1s default timed out
  // as "running" in CI run 39348003301, matching the multi-stage waits described in #59.
  await expect
    .poll(async () => (await record.subagents.list())[0]?.status, { timeout: 10_000 })
    .toBe("completed");
  for (const task of (await record.harness.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (task.record.kind === "eta.subagent-reporter")
      await record.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
  }
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const child = await runtime.runPromise(threads.openSubagent(created.id, "/research"));
  expect(child.snapshot.configuration).toEqual({
    agentMode: "standard",
    model: { provider: "eta-test", modelId: "two" },
    thinkingLevel: "high",
  });
  const childRecord = (await record.subagents.list())[0]!;
  const childConversation = (await record.harness.conversation(
    childRecord.conversationId as typeof record.conversation.id,
    BACKGROUND_CONTEXT,
  ))!;
  expect(
    (await childConversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name),
  ).toContain("bash");
  await expect
    .poll(async () => (await record.harness.inspect(BACKGROUND_CONTEXT)).submissions)
    .toHaveLength(0);
  await runtime.runPromise(
    settings.update({
      subagents: {
        mode: "opportunistic",
        maxDepth: 3,
        maxConcurrent: 2,
        presets: [],
        allowedModels: [],
      },
    }),
  );
  provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("bash");
      return fauxAssistantMessage("back to normal");
    },
  ]);
  await runtime.runPromise(threads.submit(created.id, "Continue"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await runtime.runPromise(threads.open(created.id))).snapshot.lastResult?.status).toBe(
    "completed",
  );
});

test("increasing concurrency starts queued delegates while another remains busy", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const settings = await runtime.runPromise(TestSettings);
  const policy = {
    mode: "opportunistic",
    maxDepth: 3,
    maxConcurrent: 1,
    presets: [],
    allowedModels: [],
  } as const;
  await runtime.runPromise(settings.update({ subagents: policy }));
  const created = await runtime.runPromise(threads.create(workspace.id));
  const held = holdResponse(provider, "first answer");
  await runtime.runPromise(
    threads.subagent(created.id, { action: "spawn", name: "one", message: "long task" }, "one"),
  );
  await held.ready;
  provider.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("second answer")));
  await runtime.runPromise(
    threads.subagent(created.id, { action: "spawn", name: "two", message: "queued task" }, "two"),
  );
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  expect((await record.subagents.list()).map((child) => child.status)).toEqual([
    "running",
    "queued",
  ]);
  await runtime.runPromise(settings.update({ subagents: { ...policy, maxConcurrent: 2 } }));
  await expect.poll(async () => (await record.subagents.list())[1]?.status).toBe("completed");
  expect((await record.subagents.list())[0]?.status).toBe("running");
  held.release();
  await expect.poll(async () => (await record.subagents.list())[0]?.status).toBe("completed");
  for (const task of (await record.harness.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (task.record.kind === "eta.subagent-reporter")
      await record.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
  }
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
});

test("report-like text authored by the user remains visible", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  provider.setResponses([fauxAssistantMessage("User message received")]);
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const content = "[/root/sum completed] 1 + 1 = 2.";
  await (
    await record.conversation.submit(
      { type: "input", content, requestId: "user-message" },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  const snapshot = await runtime.runPromise(threads.open(created.id));
  expect(
    snapshot.snapshot.transcript.some(
      (entry) => entry.message.role === "user" && entry.message.content === content,
    ),
  ).toBe(true);
});

test("shows child waiting on the original operation and stops the entire task tree", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const childAnswer = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  let rootRequests = 0;
  provider.setResponses(
    Array.from({ length: 10 }, () => (request, options) => {
      if (
        request.messages.findLast((message) => message.role === "user")?.content === "waiting-child"
      ) {
        options?.signal?.addEventListener(
          "abort",
          () => childAnswer.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
          { once: true },
        );
        return childAnswer.promise;
      }
      rootRequests++;
      return rootRequests === 1
        ? fauxAssistantMessage(
            [
              fauxToolCall("subagent", {
                action: "spawn",
                name: "worker",
                message: "waiting-child",
              }),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("Waiting for the child");
    }),
  );
  try {
    const input = await record.conversation.submit(
      { type: "input", content: "delegate a task" },
      BACKGROUND_CONTEXT,
    );
    await expect
      .poll(
        async () =>
          (await runtime.runPromise(threads.open(created.id))).snapshot.operation
            ?.waitingForSubagents,
      )
      .toBe(true);
    expect((await input.status(BACKGROUND_CONTEXT)).status).toBe("placed");
    expect(rootRequests).toBe(1);
    await record.subagents.stopAll();
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
    const stopped = await runtime.runPromise(threads.open(created.id));
    expect(stopped.snapshot.operation).toBeNull();
    expect(stopped.snapshot.subagents).toMatchObject([{ path: "/worker", status: "stopped" }]);
    expect(rootRequests).toBe(1);
  } finally {
    childAnswer.resolve(fauxAssistantMessage("stopped"));
  }
});

test("schedule tool applies immediately, replays once and dispatches an ordinary user prompt", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const schedules = await runtime.runPromise(ScheduleService);
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  const extension = record.registry.snapshot().extension("scheduled-tasks")!;
  let replay: (() => Promise<unknown>) | undefined;
  record.registry.install({
    ...extension,
    tools: extension.tools!.map((tool) => ({
      ...tool,
      execute: async (args, api, context) => {
        replay = () => tool.execute!(args, api, context);
        return tool.execute!(args, api, context);
      },
    })),
  });
  const at = Date.now() + 100_000;
  provider.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).toContain("schedule");
      return fauxAssistantMessage(
        fauxToolCall(
          "schedule",
          {
            action: "create",
            name: "Write reminder",
            prompt: "Write the reminder file",
            rule: { type: "once", at },
          },
          { id: "schedule-create" },
        ),
        { stopReason: "toolUse" },
      );
    },
    fauxAssistantMessage("Plan created"),
  ]);
  await runtime.runPromise(threads.submit(created.id, "Plan the reminder"));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(replay).toBeDefined();
  await replay!();
  const plans = await runtime.runPromise(schedules.list(created.id));
  expect(plans).toHaveLength(1);
  const plan = plans[0];
  expect(plan.threadId).toBe(created.id);
  expect(await runtime.runPromise(schedules.proposals(created.id))).toEqual([]);
  expect(
    JSON.stringify((await runtime.runPromise(threads.open(created.id))).snapshot.transcript),
  ).toContain(plan.id);
  const dispatcher = await runtime.runPromise(ScheduleDispatcherService);
  const host = scheduleHostAdapter(
    {
      submit: (id, prompt, requestId) => runtime.runPromise(threads.submit(id, prompt, requestId)),
      operationByRequest: (id, requestId) =>
        runtime.runPromise(threads.operationByRequest(id, requestId)),
      recovery: (id) => runtime.runPromise(threads.recovery(id)),
    },
    async () => undefined,
  );
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "reminder.txt", content: "Scheduled reminder" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Reminder saved"),
  ]);
  await runtime.runPromise(dispatcher.tick(host, at));
  await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await runtime.runPromise(dispatcher.tick(host, at + 1));
  expect(await readFile(join(workspace.cwd, "reminder.txt"), "utf8")).toBe("Scheduled reminder");
  expect((await runtime.runPromise(schedules.runs(plan.id)))[0].state).toBe("succeeded");
  const messages = (await runtime.runPromise(threads.open(created.id))).snapshot.transcript.filter(
    (entry) => entry.message.role === "user",
  );
  expect(messages).toHaveLength(2);
  expect(JSON.stringify(messages[1])).toContain("Write the reminder file");
  expect((await runtime.runPromise(schedules.runs(plan.id)))[0].inputEntryId).toBe(messages[1].id);
}, 15000);

test("schedule tool updates, pauses, resumes and deletes directly in the bound thread", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  const created = await runtime.runPromise(threads.create(workspace.id));
  const schedules = await runtime.runPromise(ScheduleService);
  const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
  await runtime.runPromise(
    schedules.write({
      threadId: created.id,
      requestId: "initial",
      change: {
        action: "create",
        name: "Original",
        prompt: "Review",
        rule: { type: "interval", everyMs: 300000, anchorAt: Date.now() + 3600000 },
      },
    }),
  );
  for (const action of ["update", "pause", "resume", "delete"] as const) {
    const plan = (await runtime.runPromise(schedules.list(created.id)))[0];
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "schedule",
          {
            action,
            scheduleId: plan.id,
            expectedRevision: plan.revision,
            ...(action === "update"
              ? {
                  patch: {
                    name: "Updated",
                    rule: {
                      type: "weekly",
                      weekdays: [1, 5],
                      time: "08:30",
                      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    },
                  },
                }
              : {}),
          },
          { id: `schedule-${action}` },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Applied"),
    ]);
    await runtime.runPromise(threads.submit(created.id, action));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    const plans = await runtime.runPromise(schedules.list(created.id));
    expect(await runtime.runPromise(schedules.proposals(created.id))).toEqual([]);
    if (action === "delete") expect(plans).toEqual([]);
    else {
      expect(plans[0].name).toBe("Updated");
      expect(plans[0].state).toBe(action === "pause" ? "paused" : "active");
      expect(plans[0].revision).toBe(plan.revision + 1);
    }
  }
}, 15000);

test.each([false, true])(
  "schedule tool stays absent from spawned and forked children with canDelegate=%s",
  async (canDelegate) => {
    const { runtime, threads, registry, workspace, provider } = await setup();
    const created = await runtime.runPromise(threads.create(workspace.id));
    provider.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Done")));
    await runtime.runPromise(threads.submit(created.id, "Establish fork history"));
    const record = await runtime.runPromise(registry.acquire(created.thread.sessionRef));
    await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
    for (const fork of [false, true]) {
      const name = fork ? "forked" : "spawned";
      const path = fork ? `/root/${name}` : `/${name}`;
      provider.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Done")));
      await runtime.runPromise(
        threads.subagent(
          created.id,
          { action: "spawn", name, fork, canDelegate, message: "Work" },
          name,
        ),
      );
      await expect
        .poll(
          async () => (await record.subagents.list()).find((child) => child.path === path)?.status,
        )
        .toBe("completed");
      for (const task of (await record.harness.inspect(BACKGROUND_CONTEXT)).tasks) {
        if (task.record.kind === "eta.subagent-reporter")
          await record.harness.waitForTask(task.record.id, BACKGROUND_CONTEXT);
      }
      await record.conversation.waitForIdle(BACKGROUND_CONTEXT);
      const child = (await record.subagents.list()).find((child) => child.path === path)!;
      const conversation = (await record.harness.conversation(
        child.conversationId as typeof record.conversation.id,
        BACKGROUND_CONTEXT,
      ))!;
      const tools = (await conversation.agent(BACKGROUND_CONTEXT)).tools.map((tool) => tool.name);
      expect(tools).not.toContain("schedule");
      expect(tools.includes("subagent")).toBe(canDelegate);
      // Simulate an old broad child configuration: execution must enforce the real caller identity.
      const tool = record.registry
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === "schedule")!.tool;
      await conversation.configure({ tools: [tool] }, BACKGROUND_CONTEXT);
      provider.setResponses([
        fauxAssistantMessage(
          fauxToolCall("schedule", {
            action: "create",
            name: "Unauthorized",
            prompt: "Work",
            rule: { type: "once", at: Date.now() + 100_000 },
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Denied"),
      ]);
      await conversation.submit({ type: "input", content: "Try legacy tool" }, BACKGROUND_CONTEXT);
      await conversation.waitForIdle(BACKGROUND_CONTEXT);
      const schedules = await runtime.runPromise(ScheduleService);
      expect(await runtime.runPromise(schedules.proposals(created.id))).toEqual([]);
      expect(
        JSON.stringify(
          (await runtime.runPromise(threads.openSubagent(created.id, path))).snapshot.transcript,
        ),
      ).toContain("定时任务工具仅对根会话开放");
    }
  },
  15000,
);

test("a new thread applies the requested configuration before its first message", async () => {
  const { runtime, threads, workspace } = await setup();
  const created = await runtime.runPromise(
    threads.create(workspace.id, "create-with-configuration", {
      provider: "eta-test",
      modelId: "two",
      thinkingLevel: "high",
      sandboxMode: "read-only",
    }),
  );
  expect(created.snapshot.configuration).toMatchObject({
    model: { provider: "eta-test", modelId: "two" },
    thinkingLevel: "high",
  });
  expect(created.snapshot.sandbox?.mode).toBe("read-only");
});

test.each([8000, undefined])(
  "closing Core settles external subagent wait timeout=%s",
  async (timeoutMs) => {
    const { runtime, threads, registry, workspace, provider, reopen } = await setup();
    const owner = await runtime.runPromise(threads.create(workspace.id));
    const record = await runtime.runPromise(registry.acquire(owner.thread.sessionRef));
    const cleanup = new AbortController();
    const run = record.subagents.execute.bind(record.subagents);
    let waitSignal: AbortSignal | undefined;
    let gateSignal: AbortSignal | undefined;
    const execute = vi
      .spyOn(record.subagents, "execute")
      .mockImplementation((command, actor, requestId, context = BACKGROUND_CONTEXT) => {
        if (command.action !== "wait") return run(command, actor, requestId, context);
        waitSignal = context.abortSignal;
        // This extra signal is only fired in finally, so an old uninterruptible implementation can clean up.
        gateSignal = waitSignal ? AbortSignal.any([waitSignal, cleanup.signal]) : cleanup.signal;
        return run(command, actor, requestId, { ...context, abortSignal: gateSignal });
      });
    const watchDoc = vi.spyOn(record.harness, "watchDoc");
    const isWaitWatch = ([definition, context]: readonly unknown[]) =>
      definition === SubagentsDoc &&
      typeof context === "object" &&
      context !== null &&
      "abortSignal" in context &&
      context.abortSignal === gateSignal;
    let watchStopped = () => false;
    const held = holdResponse(provider, "Delegated result");
    let ready = false;
    void held.ready.then(() => {
      ready = true;
    });
    let waiting: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      const children = await runtime.runPromise(
        threads.subagent(
          owner.id,
          {
            action: "spawn",
            name: "held",
            message: "Hold work across close",
            wait: false,
          },
          "wait-close-spawn",
        ),
      );
      await expect.poll(() => ready, { timeout: 5000 }).toBe(true);
      let waitSettled = false;
      waiting = runtime.runPromise(
        threads.subagent(
          owner.id,
          {
            action: "wait",
            path: children[0]!.path,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          },
          "wait-close-read",
        ),
      );
      void waiting.then(
        () => {
          waitSettled = true;
        },
        () => {
          waitSettled = true;
        },
      );
      await expect
        .poll(() => execute.mock.calls.some(([command]) => command.action === "wait"), {
          timeout: 5000,
        })
        .toBe(true);
      await expect.poll(() => watchDoc.mock.calls.some(isWaitWatch), { timeout: 5000 }).toBe(true);
      const index = watchDoc.mock.calls.findIndex(isWaitWatch);
      const watch = await watchDoc.mock.results[index]!.value;
      if (!watch) throw new Error("Expected an actual wait watch");
      const stopWatch = vi.spyOn(watch, "stop");
      watchStopped = () => stopWatch.mock.calls.length > 0;
      expect(waitSettled).toBe(false);
      let disposed = false;
      closing = runtime.dispose();
      void closing.then(
        () => {
          disposed = true;
        },
        () => {
          disposed = true;
        },
      );
      await expect.poll(() => disposed, { timeout: 3000 }).toBe(true);
      await closing;
      await expect.poll(() => waitSettled, { timeout: 2000 }).toBe(true);
      expect(waitSignal?.aborted).toBe(true);
      await expect.poll(watchStopped, { timeout: 2000 }).toBe(true);
      const next = reopen();
      const other = await next.runPromise(ThreadService);
      const recovered = await next.runPromise(other.open(owner.id));
      expect(recovered.snapshot.recoveryRequired).toBe(true);
      expect(recovered.snapshot.subagents).toHaveLength(1);
      expect(recovered.snapshot.subagents?.[0]?.status).not.toBe("stopped");
      await next.runPromise(other.stop(owner.id));
    } finally {
      cleanup.abort();
      held.release();
      await Promise.allSettled([...(waiting ? [waiting] : []), ...(closing ? [closing] : [])]);
      execute.mockRestore();
      watchDoc.mockRestore();
    }
  },
  15000,
);

test("listing subagents preserves recovery pause until explicit resume", async () => {
  const { runtime, directory, cwd, models, workspace, threads } = await setup();
  const owner = await runtime.runPromise(threads.create(workspace.id));
  await runtime.dispose();
  let checkpointed = false;
  let executions = 0;
  const marker = join(cwd, "recovered-host-task.txt");
  const task = defineTask<null, { phase: "start" } | { phase: "finish" }, string>({
    name: "test.list-recovery",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "finish" } }),
          context,
        );
        checkpointed = true;
        await new Promise<void>((resolve) =>
          runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        runtime.signal.throwIfAborted();
      },
      finish: async (_task, runtime, context) => {
        await writeFile(marker, "Executed persisted checkpoint");
        executions++;
        return runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: "done" } }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const open = () => {
    const runtime = ManagedRuntime.make(
      coreServices({
        dataRoot: join(directory, "data"),
        home: directory,
        models,
        settings: {
          read: Effect.succeed({ defaultThinkingLevel: "off" }),
          subscribe: () => () => {},
        },
        environment: {
          shutdown: "preserve",
          extensions: () => [{ name: "test-host", tasks: [task] }],
        },
      }),
    );
    runtimes.push(runtime);
    return runtime;
  };
  const before = open();
  const beforeThreads = await before.runPromise(ThreadService);
  const accepted = await before.runPromise(
    beforeThreads.enqueueTask(owner.id, "test.list-recovery", null, "host-checkpoint"),
  );
  await expect.poll(() => checkpointed, { timeout: 5000 }).toBe(true);
  await before.dispose();
  const next = open();
  const restoredThreads = await next.runPromise(ThreadService);
  expect((await next.runPromise(restoredThreads.open(owner.id))).snapshot.recoveryRequired).toBe(
    true,
  );
  const registry = await next.runPromise(RuntimeRegistryService);
  const restored = await next.runPromise(registry.acquire(owner.thread.sessionRef));
  expect((await restored.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe("paused");
  expect(executions).toBe(0);
  expect(
    await next.runPromise(restoredThreads.subagent(owner.id, { action: "list" }, "read-only-list")),
  ).toEqual([]);
  const scheduling = (await restored.harness.inspect(BACKGROUND_CONTEXT)).scheduling;
  const state = async () =>
    (await next.runPromise(restoredThreads.task(owner.id, accepted.taskId))).state;
  // On the old implementation, observe actual checkpoint execution rather than just a resume callback.
  if (scheduling !== "paused") {
    await expect
      .poll(state, { timeout: 5000 })
      .toMatchObject({ status: "terminal", outcome: { status: "completed" } });
    expect(await readFile(marker, "utf8")).toBe("Executed persisted checkpoint");
  }
  expect({ scheduling, executions }).toEqual({ scheduling: "paused", executions: 0 });
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await next.runPromise(restoredThreads.open(owner.id))).snapshot.recoveryRequired).toBe(
    true,
  );
  await next.runPromise(restoredThreads.resume(owner.id));
  await expect
    .poll(state, { timeout: 5000 })
    .toMatchObject({ status: "terminal", outcome: { status: "completed" } });
  expect(executions).toBe(1);
  expect(await readFile(marker, "utf8")).toBe("Executed persisted checkpoint");
  expect((await next.runPromise(restoredThreads.open(owner.id))).snapshot.recoveryRequired).toBe(
    false,
  );
}, 15000);
