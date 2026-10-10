import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { Effect } from "effect";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { defineTask, defineTool } from "@eta/agent";
import type { CoreEnvironment } from "../src/service/environment.ts";
import { createCore } from "../src/client.ts";
import type { CoreClient } from "../src/client.ts";

const clients: CoreClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-core-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "core-test",
    models: [{ id: "one" }],
    tokensPerSecond: 10000,
  });
  const titles = fauxProvider({
    provider: "core-test",
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
  const open = async (data = "data", environment: Partial<CoreEnvironment> = {}) => {
    const client = await createCore({
      dataRoot: join(directory, data),
      home: directory,
      models,
      settings: {
        read: Effect.succeed({ defaultThinkingLevel: "off" }),
        subscribe: () => () => {},
      },
      environment: { userAgent: "eta-core-test", shutdown: "preserve", ...environment },
    });
    clients.push(client);
    return client;
  };
  const core = await open();
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  return { core, open, provider, cwd, workspace };
}

test("headless execution retains older operation results and idempotency after restart", async () => {
  const { core, open, provider, cwd, workspace } = await fixture();
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "proof.txt", content: "Executed by Core" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("First result"),
    fauxAssistantMessage("Second result"),
  ]);
  const thread = await core.createThread(workspace.id, "create-request");
  expect((await core.createThread(workspace.id, "create-request")).id).toBe(thread.id);
  const first = await core.submit(thread.id, "Write a file", "input-request");
  await expect
    .poll(async () => (await core.operation(thread.id, first.operationId)).status)
    .toBe("completed");
  expect(await readFile(join(cwd, "proof.txt"), "utf8")).toBe("Executed by Core");
  const second = await core.submit(thread.id, "Continue", "second-request");
  await expect
    .poll(async () => (await core.operation(thread.id, second.operationId)).status)
    .toBe("completed");
  const result = await core.operation(thread.id, first.operationId);
  expect(JSON.stringify(result.messages)).toContain("First result");
  await core.close();
  const restored = await open();
  expect(await restored.operation(thread.id, first.operationId)).toEqual(result);
  expect(await restored.submit(thread.id, "Write a file", "input-request")).toEqual(first);
  await expect(restored.operation(thread.id, "invalid")).rejects.toMatchObject({
    code: "InvalidInput",
  });
  await expect(restored.operation(thread.id, "999999")).rejects.toMatchObject({ code: "NotFound" });
});

test("registered host tasks admit once, preserve checkpoints and block recovery when their definition is missing", async () => {
  const { core, open, workspace } = await fixture();
  const thread = await core.createThread(workspace.id);
  await core.close();
  const checkpointed = Promise.withResolvers<void>();
  const task = defineTask<{ value: string }, { phase: "start" } | { phase: "finish" }, string>({
    name: "test.host-work",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "finish" } }),
          context,
        );
        checkpointed.resolve();
        await new Promise<void>((resolve) =>
          runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        runtime.signal.throwIfAborted();
      },
      finish: (task, runtime, context) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: task.input.value },
          }),
          context,
        ),
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const environment = { extensions: () => [{ name: "test-host", tasks: [task] }] };
  const registered = await open("data", environment);
  const accepted = await registered.enqueueTask(
    thread.id,
    "test.host-work",
    { value: "persisted value" },
    "host-request",
  );
  await checkpointed.promise;
  expect(
    await registered.enqueueTask(
      thread.id,
      "test.host-work",
      { value: "persisted value" },
      "host-request",
    ),
  ).toEqual(accepted);
  await expect(
    registered.enqueueTask(thread.id, "test.host-work", { value: "different" }, "host-request"),
  ).rejects.toMatchObject({ code: "InvalidInput" });
  await registered.close();
  const missing = await open();
  expect(await missing.recovery(thread.id)).toMatchObject({
    required: true,
    blockedTasks: [{ kind: "test.host-work", reason: "missing_task" }],
  });
  await missing.close();
  const restored = await open("data", environment);
  expect(
    await restored.enqueueTask(
      thread.id,
      "test.host-work",
      { value: "persisted value" },
      "host-request",
    ),
  ).toEqual(accepted);
  expect((await restored.task(thread.id, accepted.taskId)).state).toMatchObject({
    checkpoint: { phase: "finish" },
  });
  await restored.resume(thread.id);
  await expect
    .poll(async () => (await restored.task(thread.id, accepted.taskId)).state)
    .toMatchObject({
      status: "terminal",
      outcome: { status: "completed", result: "persisted value" },
    });
});

test("independent Core instances do not share catalogs or live execution", async () => {
  const { core, open, provider, workspace } = await fixture();
  const isolated = await open("another-data-root");
  expect(await isolated.projects()).toEqual([]);
  expect(await isolated.threads()).toEqual([]);
  const thread = await core.createThread(workspace.id);
  provider.setResponses([fauxAssistantMessage("Only the first instance")]);
  const admitted = await core.submit(thread.id, "Run");
  await expect
    .poll(async () => (await core.operation(thread.id, admitted.operationId)).status)
    .toBe("completed");
  await expect(isolated.openThread(thread.id)).rejects.toMatchObject({ code: "NotFound" });
  expect(await isolated.threads()).toEqual([]);
});

test("workspace network access needs no approval and survives a separate filesystem grant", async () => {
  const { core, provider, cwd, workspace } = await fixture();
  const externalFile = join(cwd, "../external.txt");
  await writeFile(externalFile, "outside file");
  const server = createServer((_request, response) => response.end("network allowed"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const fetch = `/usr/bin/curl --silent --show-error --max-time 2 --noproxy '*' http://127.0.0.1:${address.port}`;
    const quotedFile = `'${externalFile.replaceAll("'", "'\\''")}'`;
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `${fetch} > network.txt`,
          sandbox: { networkAccess: true, reason: "Fetch a page" },
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `(${fetch} && cat ${quotedFile}) > granted.txt`,
          sandbox: { readableRoots: [externalFile], reason: "Read an external file" },
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Done"),
    ]);
    const thread = await core.createThread(workspace.id);
    const operation = await core.submit(thread.id, "Fetch and read");
    await expect
      .poll(async () => readFile(join(cwd, "network.txt"), "utf8").catch(() => ""))
      .toBe("network allowed");
    await expect
      .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length)
      .toBe(1);
    const approval = (await core.openThread(thread.id)).snapshot.approvals![0]!;
    expect(approval).toMatchObject({ reason: "Read an external file", networkAccess: false });
    await core.decideApproval(thread.id, approval.id, true);
    await expect
      .poll(async () => (await core.operation(thread.id, operation.operationId)).status)
      .toBe("completed");
    expect(await readFile(join(cwd, "granted.txt"), "utf8")).toBe("network allowedoutside file");
    expect((await core.openThread(thread.id)).snapshot.approvals).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("read-only pauses edits for one exact approval and persists the selected policy", async () => {
  const { core, open, provider, cwd, workspace } = await fixture();
  const thread = await core.createThread(workspace.id);
  expect(thread.snapshot.sandbox?.mode).toBe("workspace-write");
  await core.configureSandbox(thread.id, "read-only");
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "approved.txt", content: "approved once" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await core.submit(thread.id, "Write");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length)
    .toBe(1);
  await expect(readFile(join(cwd, "approved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(core.configureSandbox(thread.id, "danger-full-access")).rejects.toMatchObject({
    code: "Busy",
  });
  const approval = (await core.openThread(thread.id)).snapshot.approvals![0]!;
  expect(approval).toMatchObject({
    tool: "write",
    mode: "read-only",
    args: { path: "approved.txt", content: "approved once" },
  });
  await core.decideApproval(thread.id, approval.id, true);
  await expect
    .poll(async () => (await core.operation(thread.id, operation.operationId)).status)
    .toBe("completed");
  expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("approved once");
  await expect(core.decideApproval(thread.id, approval.id, true)).rejects.toMatchObject({
    code: "NotFound",
  });
  await core.close();
  const restored = await open();
  expect((await restored.openThread(thread.id)).snapshot.sandbox?.mode).toBe("read-only");
});

test.each(["deny", "stop"] as const)(
  "%s cancels a waiting command without executing it",
  async (decision) => {
    const { core, provider, cwd, workspace } = await fixture();
    const thread = await core.createThread(workspace.id);
    await core.configureSandbox(thread.id, "read-only");
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf escaped > command.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Denied"),
    ]);
    const operation = await core.submit(thread.id, "Run");
    await expect
      .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length)
      .toBe(1);
    const approval = (await core.openThread(thread.id)).snapshot.approvals![0]!;
    if (decision === "deny") await core.decideApproval(thread.id, approval.id, false);
    else await core.stop(thread.id);
    await expect
      .poll(async () => (await core.operation(thread.id, operation.operationId)).status)
      .toBe(decision === "deny" ? "completed" : "aborted");
    await expect(readFile(join(cwd, "command.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await core.openThread(thread.id)).snapshot.approvals).toEqual([]);
  },
);

test("environment ceilings reject full access for new and existing threads", async () => {
  const { core, open, workspace } = await fixture();
  const thread = await core.createThread(workspace.id);
  await core.close();
  const constrained = await open("data", { allowedSandboxModes: ["read-only", "workspace-write"] });
  await expect(constrained.configureSandbox(thread.id, "danger-full-access")).rejects.toMatchObject(
    { code: "InvalidInput" },
  );
  await expect(
    constrained.createThread(workspace.id, undefined, {
      provider: "core-test",
      modelId: "one",
      thinkingLevel: "off",
      sandboxMode: "danger-full-access",
    }),
  ).rejects.toMatchObject({ code: "InvalidInput" });
});

test("pending approvals survive restart without executing before explicit resume and approval", async () => {
  const { core, open, provider, cwd, workspace } = await fixture();
  const thread = await core.createThread(workspace.id);
  await core.configureSandbox(thread.id, "read-only");
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "restart.txt", content: "after approval" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await core.submit(thread.id, "Write");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length)
    .toBe(1);
  const approval = (await core.openThread(thread.id)).snapshot.approvals![0]!;
  await core.close();
  const restored = await open();
  expect((await restored.openThread(thread.id)).snapshot.approvals).toMatchObject([
    { id: approval.id },
  ]);
  await expect(readFile(join(cwd, "restart.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(restored.decideApproval(thread.id, approval.id, true)).rejects.toMatchObject({
    code: "RecoveryRequired",
  });
  await restored.resume(thread.id);
  await restored.decideApproval(thread.id, approval.id, true);
  await expect
    .poll(async () => (await restored.operation(thread.id, operation.operationId)).status, {
      timeout: 5000,
    })
    .toBe("completed");
  expect(await readFile(join(cwd, "restart.txt"), "utf8")).toBe("after approval");
});

test("subagents inherit read-only policy and expose their own requests to the owning thread", async () => {
  const { core, provider, cwd, workspace } = await fixture();
  const thread = await core.createThread(workspace.id);
  await core.configureSandbox(thread.id, "read-only");
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "child.txt", content: "approved child" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Child finished"),
  ]);
  await core.subagent(
    thread.id,
    { action: "spawn", name: "worker", message: "Write" },
    "child-spawn",
  );
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length, {
      timeout: 5000,
    })
    .toBe(1);
  const snapshot = (await core.openThread(thread.id)).snapshot;
  const request = snapshot.approvals![0]!;
  expect(request).toMatchObject({
    mode: "read-only",
    conversationId: String(snapshot.subagents![0]!.conversationId),
  });
  await expect(readFile(join(cwd, "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(core.configureSandbox(thread.id, "danger-full-access")).rejects.toMatchObject({
    code: "Busy",
  });
  await core.decideApproval(thread.id, request.id, true);
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.subagents?.[0]?.status, {
      timeout: 5000,
    })
    .toBe("completed");
  expect(await readFile(join(cwd, "child.txt"), "utf8")).toBe("approved child");
});

test("an unavailable worker blocks execution without changing the stored sandbox policy", async () => {
  const { core, open, provider, cwd, workspace } = await fixture();
  await core.close();
  const broken = await open("data", { sandboxWorkerPath: join(cwd, "missing-worker.mjs") });
  const thread = await broken.createThread(workspace.id);
  expect(thread.snapshot.sandbox).toMatchObject({ mode: "workspace-write", available: false });
  await expect(broken.submit(thread.id, "Write")).rejects.toMatchObject({
    code: "SandboxUnavailable",
  });
  await broken.close();
  const restored = await open();
  expect((await restored.openThread(thread.id)).snapshot.sandbox).toMatchObject({
    mode: "workspace-write",
    available: true,
  });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "restored.txt", content: "safe" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await restored.submit(thread.id, "Write");
  await expect
    .poll(async () => (await restored.operation(thread.id, operation.operationId)).status, {
      timeout: 5000,
    })
    .toBe("completed");
  expect(await readFile(join(cwd, "restored.txt"), "utf8")).toBe("safe");
});

test("an approved read-only command receives only its requested workspace scope", async () => {
  const { core, provider, cwd, workspace } = await fixture();
  const thread = await core.createThread(workspace.id);
  await core.configureSandbox(thread.id, "read-only");
  provider.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command: "printf approved > command.txt",
        sandbox: { reason: "Write the requested result", writableRoots: [cwd] },
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done"),
  ]);
  const operation = await core.submit(thread.id, "Write");
  await expect
    .poll(async () => (await core.openThread(thread.id)).snapshot.approvals?.length)
    .toBe(1);
  await expect(readFile(join(cwd, "command.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  const request = (await core.openThread(thread.id)).snapshot.approvals![0]!;
  expect(request.writableRoots).toHaveLength(1);
  await core.decideApproval(thread.id, request.id, true);
  await expect
    .poll(async () => (await core.operation(thread.id, operation.operationId)).status, {
      timeout: 5000,
    })
    .toBe("completed");
  expect(await readFile(join(cwd, "command.txt"), "utf8")).toBe("approved");
  expect((await core.openThread(thread.id)).snapshot.sandbox?.mode).toBe("read-only");
});

test("host model catalogs and mutable default settings stay local to each Core instance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-core-hosts-"));
  directories.push(directory);
  const cwd = join(directory, "workspace");
  await mkdir(cwd);
  const openHost = async (name: string, initialModel: string) => {
    const models = createModels();
    models.setProvider(
      fauxProvider({ provider: name, models: [{ id: "one" }, { id: "two" }] }).provider,
    );
    let defaultModel = initialModel;
    const core = await createCore({
      dataRoot: join(directory, name),
      home: join(directory, name, "home"),
      models,
      settings: {
        read: Effect.sync(() => ({
          defaultProvider: name,
          defaultModel,
          defaultThinkingLevel: "off" as const,
        })),
        subscribe: () => () => {},
      },
      environment: { userAgent: name, shutdown: "preserve" },
    });
    clients.push(core);
    const project = await core.registerProject(cwd);
    const workspace = (await core.workspaces(project.id))[0]!;
    return {
      core,
      workspace,
      setModel: (model: string) => {
        defaultModel = model;
      },
    };
  };
  const desktop = await openHost("desktop-host", "one");
  const bot = await openHost("bot-host", "two");
  expect((await desktop.core.models()).map(({ provider }) => provider)).toEqual([
    "desktop-host",
    "desktop-host",
  ]);
  expect((await bot.core.models()).map(({ provider }) => provider)).toEqual([
    "bot-host",
    "bot-host",
  ]);
  expect((await desktop.core.createThread(desktop.workspace.id)).model.id).toBe("one");
  expect((await bot.core.createThread(bot.workspace.id)).model.id).toBe("two");
  desktop.setModel("two");
  expect((await desktop.core.createThread(desktop.workspace.id)).model.id).toBe("two");
  bot.setModel("one");
  expect((await bot.core.createThread(bot.workspace.id)).model.id).toBe("one");
  expect((await desktop.core.createThread(desktop.workspace.id)).model.id).toBe("two");
});

test("preserving shutdown retains an unfinished input that resumes without resubmission", async () => {
  const { core, open, provider, workspace } = await fixture();
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
  const thread = await core.createThread(workspace.id);
  const admission = await core.submit(thread.id, "Finish after restart", "surviving-request");
  await entered.promise;
  await core.close();
  const restored = await open();
  expect((await restored.operation(thread.id, admission.operationId)).status).toBe("paused");
  expect(await restored.recovery(thread.id)).toMatchObject({
    required: true,
    unsafeTool: false,
    blockedTasks: [],
  });
  provider.setResponses([fauxAssistantMessage("Recovered result")]);
  await restored.resume(thread.id);
  await expect
    .poll(async () => (await restored.operation(thread.id, admission.operationId)).status)
    .toBe("completed");
  expect(
    JSON.stringify((await restored.operation(thread.id, admission.operationId)).messages),
  ).toContain("Recovered result");
  const history = (await restored.openThread(thread.id)).snapshot.transcript.filter(
    ({ message }) => message.role === "user",
  );
  expect(history).toHaveLength(1);
});

test.each(["safe", "unsafe", "missing"] as const)(
  "recovery checks the current %s tool definition as well as the recorded replay policy",
  async (policy) => {
    const { core, open, provider, workspace } = await fixture();
    await core.close();
    const entered = Promise.withResolvers<void>();
    let executions = 0;
    const tool = defineTool({
      name: "recoverable-work",
      description: "A controlled interruption",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_input, _api, context) => {
        executions++;
        if (executions === 1) {
          entered.resolve();
          await new Promise<void>((resolve) =>
            context.abortSignal!.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        return {};
      },
    });
    const original = await open("data", {
      extensions: () => [{ name: "test-tool", tools: [tool] }],
    });
    const thread = await original.createThread(workspace.id);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall(tool.name, {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Recovered"),
    ]);
    const input = await original.submit(thread.id, "Work", "replay-request");
    await entered.promise;
    await original.close();
    const restored = await open("data", {
      extensions: () =>
        policy === "missing" ? [] : [{ name: "test-tool", tools: [{ ...tool, replay: policy }] }],
    });
    expect(await restored.recovery(thread.id)).toMatchObject({
      required: true,
      unsafeTool: policy !== "safe",
    });
    if (policy === "safe") {
      await restored.resume(thread.id);
      await expect
        .poll(async () => (await restored.operation(thread.id, input.operationId)).status)
        .toBe("completed");
      expect(executions).toBe(2);
    } else {
      expect(executions).toBe(1);
      await restored.stop(thread.id);
      expect((await restored.operation(thread.id, input.operationId)).status).toBe("aborted");
    }
  },
);
