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
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import { DesktopCatalogService } from "../../catalog/index.ts";
import { desktopServices } from "../../layer.ts";
import { ModelCatalogService } from "../../models/index.ts";
import { ProjectService } from "../../projects/index.ts";
import { RuntimeRegistryService } from "../../runtime/index.ts";
import { DesktopSettingsService } from "../../settings/index.ts";
import { WorkspaceService } from "../../workspaces/index.ts";
import { ThreadService } from "../index.ts";

const directories: string[] = [];
const runtimes: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "eta-durable-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "eta-test",
    models: [{ id: "one" }, { id: "two" }],
    tokensPerSecond: 1000,
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const reopen = () => {
    const runtime = ManagedRuntime.make(
      desktopServices(join(directory, "data"), ModelCatalogService.layerWith(models)),
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
  return { directory, cwd, runtime, provider, models, reopen, threads, registry, workspace };
}

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

test("different threads cannot run side effects concurrently in the same cwd", async () => {
  const { runtime, threads, registry, workspace, provider } = await setup();
  provider.setResponses([fauxAssistantMessage("Long running answer ".repeat(50))]);
  const one = await runtime.runPromise(threads.create(workspace.id));
  const two = await runtime.runPromise(threads.create(workspace.id));
  await runtime.runPromise(threads.submit(one.id, "Start"));
  expect(await runtime.runPromise(Effect.flip(threads.submit(two.id, "Conflict")))).toMatchObject({
    code: "Busy",
  });
  await runtime.runPromise(threads.stop(one.id));
  expect((await runtime.runPromise(threads.open(one.id))).snapshot.lastResult?.status).toBe(
    "aborted",
  );
  await runtime.runPromise(threads.submit(two.id, "Now allowed"));
  await (
    await runtime.runPromise(registry.acquire(two.thread.sessionRef))
  ).conversation.waitForIdle(BACKGROUND_CONTEXT);
});

test("retrying an admitted request returns its receipt rather than launching another run", async () => {
  const { runtime, threads, workspace, provider } = await setup();
  provider.setResponses([fauxAssistantMessage("Still running ".repeat(200))]);
  const created = await runtime.runPromise(threads.create(workspace.id));
  const first = await runtime.runPromise(threads.submit(created.id, "Only once", "input-once"));
  const repeated = await runtime.runPromise(threads.submit(created.id, "Only once", "input-once"));
  expect(repeated.operationId).toBe(first.operationId);
  await runtime.runPromise(threads.stop(created.id));
  expect(
    (await runtime.runPromise(threads.open(created.id))).snapshot.transcript.filter(
      (entry) => entry.message.role === "user",
    ),
  ).toHaveLength(1);
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
