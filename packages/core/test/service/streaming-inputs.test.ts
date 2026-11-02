import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vite-plus/test";
import { createCore, type CoreClient } from "../../src/client.ts";

const clients: CoreClient[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eta-streaming-inputs-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const provider = fauxProvider({
    provider: "queue-test",
    models: [{ id: "one" }],
    tokensPerSecond: 100000,
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const open = async () => {
    const core = await createCore({
      dataRoot: join(root, "data"),
      home: root,
      models,
      settings: {
        read: Effect.succeed({ agentMode: "standard", defaultThinkingLevel: "off" }),
        subscribe: () => () => {},
      },
      environment: {
        userAgent: "queue-test",
        shutdown: "preserve",
        allowedSandboxModes: ["danger-full-access"],
      },
    });
    clients.push(core);
    return core;
  };
  const core = await open();
  const project = await core.registerProject(cwd);
  const workspace = (await core.workspaces(project.id))[0]!;
  const thread = await core.createThread(workspace.id, undefined, {
    provider: "queue-test",
    modelId: "one",
    thinkingLevel: "off",
    sandboxMode: "danger-full-access",
  });
  await core.renameThread(thread.id, "Queue test");
  return { core, open, provider, thread };
}
function gate() {
  const reached = Promise.withResolvers<void>();
  const response = Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const step = (_request: unknown, options?: { signal?: AbortSignal }) => {
    reached.resolve();
    options?.signal?.addEventListener(
      "abort",
      () => response.resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
      { once: true },
    );
    return response.promise;
  };
  return { reached: reached.promise, response, step };
}

test("steers precede earlier follow-ups and each request is independently addressable", async () => {
  const { core, provider, thread } = await fixture();
  const first = gate();
  const second = gate();
  const third = gate();
  provider.setResponses([
    first.step,
    second.step,
    third.step,
    fauxAssistantMessage("follow-up done"),
  ]);
  try {
    await core.submit(thread.id, "original", "original");
    await first.reached;
    const follow = await core.submit(thread.id, "afterwards", "constructor", undefined, "followUp");
    const steer = await core.submit(thread.id, "constraint one", "__proto__", undefined, "steer");
    const steer2 = await core.submit(thread.id, "constraint two", "steer-two", undefined, "steer");
    expect(follow.status).toBe("queued");
    expect(
      (await core.openThread(thread.id)).snapshot.queuedInputs?.map((input) => input.requestId),
    ).toEqual(["constructor", "__proto__", "steer-two"]);
    expect(
      (await core.openThread(thread.id)).snapshot.queuedInputs?.map((input) => input.operationId),
    ).toEqual([follow.operationId, steer.operationId, steer2.operationId]);
    await expect(
      core.submit(thread.id, "afterwards", "constructor", undefined, "steer"),
    ).rejects.toMatchObject({ code: "InvalidInput" });
    expect(
      (await core.submit(thread.id, "afterwards", "constructor", undefined, "followUp"))
        .operationId,
    ).toBe(follow.operationId);
    first.response.resolve(fauxAssistantMessage("original complete"));
    await second.reached;
    const users = (await core.openThread(thread.id)).snapshot.transcript
      .filter((entry) => entry.message.role === "user")
      .map((entry) => entry.message.content);
    expect(users).toEqual(["original", "constraint one"]);
    expect(
      (await core.openThread(thread.id)).snapshot.transcript
        .filter((entry) => entry.message.role === "user")
        .map((entry) => entry.requestId),
    ).toEqual(["original", "__proto__"]);
    expect((await core.operation(thread.id, follow.operationId)).status).toBe("queued");
    second.response.resolve(fauxAssistantMessage("first constraint complete"));
    await third.reached;
    expect((await core.operation(thread.id, follow.operationId)).status).toBe("queued");
    expect((await core.operation(thread.id, steer2.operationId)).status).toBe("running");
    third.response.resolve(fauxAssistantMessage("second constraint complete"));
    await expect
      .poll(async () => (await core.operation(thread.id, follow.operationId)).status, {
        timeout: 10000,
      })
      .toBe("completed");
    expect((await core.openThread(thread.id)).snapshot.queuedInputs).toEqual([]);
  } finally {
    first.response.resolve(fauxAssistantMessage("released"));
    second.response.resolve(fauxAssistantMessage("released"));
    third.response.resolve(fauxAssistantMessage("released"));
  }
}, 30000);

test("withdrawn and stopped queued inputs retain content across reopen without executing it", async () => {
  const { core, open, provider, thread } = await fixture();
  const first = gate();
  const draft = "keep the full draft ".repeat(4000);
  provider.setResponses([first.step]);
  try {
    const original = await core.submit(thread.id, "original", "root");
    await first.reached;
    const queued = await core.submit(thread.id, draft, "constructor", undefined, "followUp");
    expect(await core.withdrawInput(thread.id, queued.operationId)).toEqual({
      status: "withdrawn",
      prompt: draft,
      images: [],
    });
    expect((await core.withdrawInput(thread.id, original.operationId)).status).toBe(
      "already_placed",
    );
    const stopped = await core.submit(thread.id, "do not run", "__proto__", undefined, "steer");
    await core.stop(thread.id);
    expect((await core.operation(thread.id, stopped.operationId)).status).toBe("aborted");
    await core.close();
    const reopened = await open();
    expect(
      (await reopened.openThread(thread.id)).snapshot.queuedInputs?.map((item) => item.status),
    ).toEqual(["cancelled", "cancelled"]);
    expect(await reopened.withdrawInput(thread.id, stopped.operationId)).toMatchObject({
      status: "settled",
      prompt: "do not run",
    });
    expect((await reopened.operationByRequest(thread.id, "constructor"))?.operationId).toBe(
      queued.operationId,
    );
    expect((await reopened.operationByRequest(thread.id, "__proto__"))?.operationId).toBe(
      stopped.operationId,
    );
    await expect(
      reopened.submit(thread.id, "changed", "__proto__", undefined, "steer"),
    ).rejects.toMatchObject({ code: "InvalidInput" });
    expect(provider.state.callCount).toBe(1);
  } finally {
    first.response.resolve(fauxAssistantMessage("released"));
  }
}, 30000);

test("terminal model failure cancels queued input without running it and preserves attachments", async () => {
  const { core, provider, thread } = await fixture();
  const first = gate();
  provider.setResponses([first.step]);
  const image = {
    type: "image" as const,
    data: "AA==",
    mimeType: "image/png",
    name: "constraint.png",
    note: "Image orientation corrected",
  };
  try {
    const original = await core.submit(thread.id, "original", "root");
    await first.reached;
    const queued = await core.submit(thread.id, "image instruction", "next", [image], "steer");
    const snapshot = (await core.openThread(thread.id)).snapshot;
    expect(snapshot.queuedInputs?.[0]).toMatchObject({
      prompt: "image instruction",
      images: [{ name: image.name, mimeType: image.mimeType }],
    });
    expect(snapshot.queuedInputs?.[0]?.images[0]).not.toHaveProperty("data");
    expect(queued.startedAt).toBe(snapshot.queuedInputs?.[0]?.submittedAt);
    expect((await core.operation(thread.id, queued.operationId)).startedAt).toBe(queued.startedAt);
    first.response.resolve(
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Invalid request" }),
    );
    await expect
      .poll(async () => (await core.operation(thread.id, queued.operationId)).status)
      .toBe("failed");
    const failed = (await core.openThread(thread.id)).snapshot;
    expect(failed.queuedInputs?.[0]?.status).toBe("failed");
    expect(failed.lastResult).toMatchObject({
      operationId: original.operationId,
      status: "failed",
      error: { message: "Invalid request" },
    });
    expect(await core.withdrawInput(thread.id, queued.operationId)).toMatchObject({
      status: "settled",
      prompt: "image instruction",
      images: [image],
    });
    expect(provider.state.callCount).toBe(1);
  } finally {
    first.response.resolve(fauxAssistantMessage("released"));
  }
}, 30000);

test("a full queue rejects without eviction and a withdrawal frees capacity", async () => {
  const { core, provider, thread } = await fixture();
  const first = gate();
  provider.setResponses([first.step]);
  try {
    await core.submit(thread.id, "original", "root");
    await first.reached;
    const admissions = [];
    for (let index = 0; index < 32; index++)
      admissions.push(
        await core.submit(thread.id, String(index), String(index), undefined, "followUp"),
      );
    await expect(
      core.submit(thread.id, "overflow", "overflow", undefined, "steer"),
    ).rejects.toMatchObject({ code: "Busy" });
    expect(
      (await core.openThread(thread.id)).snapshot.queuedInputs?.filter(
        (item) => item.status === "queued",
      ),
    ).toHaveLength(32);
    expect(await core.operationByRequest(thread.id, "overflow")).toBeUndefined();
    await core.withdrawInput(thread.id, admissions[0]!.operationId);
    await expect(
      core.submit(thread.id, "overflow", "overflow", undefined, "steer"),
    ).resolves.toMatchObject({ status: "queued" });
    expect(provider.state.callCount).toBe(1);
    await core.stop(thread.id);
    expect(await core.withdrawInput(thread.id, admissions[0]!.operationId)).toMatchObject({
      status: "settled",
      prompt: "0",
    });
  } finally {
    first.response.resolve(fauxAssistantMessage("released"));
  }
}, 30000);

test("opening preserved queued work is read-only until explicit recovery or stop", async () => {
  const { core, open, provider, thread } = await fixture();
  const first = gate();
  provider.setResponses([first.step]);
  try {
    await core.submit(thread.id, "original", "root");
    await first.reached;
    const queued = await core.submit(
      thread.id,
      "preserve this",
      "__proto__",
      undefined,
      "followUp",
    );
    await core.close();
    const reopened = await open();
    const snapshot = (await reopened.openThread(thread.id)).snapshot;
    expect(snapshot.recoveryRequired).toBe(true);
    expect(snapshot.queuedInputs).toContainEqual(
      expect.objectContaining({
        operationId: queued.operationId,
        mode: "followUp",
        status: "queued",
      }),
    );
    expect(provider.state.callCount).toBe(1);
    await expect(
      reopened.submit(thread.id, "do not resume", "later", undefined, "steer"),
    ).rejects.toMatchObject({ code: "RecoveryRequired" });
    await reopened.stop(thread.id);
    expect(await reopened.withdrawInput(thread.id, queued.operationId)).toMatchObject({
      status: "settled",
      prompt: "preserve this",
    });
    expect(provider.state.callCount).toBe(1);
  } finally {
    first.response.resolve(fauxAssistantMessage("released"));
  }
}, 30000);

test("withdrawal racing the final boundary never reports a placed input as unexecuted", async () => {
  const { core, provider, thread } = await fixture();
  const first = gate(),
    second = gate();
  provider.setResponses([first.step, second.step]);
  try {
    await core.submit(thread.id, "original", "root");
    await first.reached;
    const queued = await core.submit(thread.id, "racing input", "race", undefined, "followUp");
    const withdrawing = core.withdrawInput(thread.id, queued.operationId);
    first.response.resolve(fauxAssistantMessage("original complete"));
    const result = await withdrawing;
    await core.stop(thread.id);
    if (result.status === "withdrawn") {
      expect(provider.state.callCount).toBe(1);
      expect((await core.openThread(thread.id)).snapshot.queuedInputs).toContainEqual(
        expect.objectContaining({ operationId: queued.operationId, status: "cancelled" }),
      );
    } else {
      expect(result).toEqual({ status: "already_placed" });
      expect((await core.openThread(thread.id)).snapshot.queuedInputs).not.toContainEqual(
        expect.objectContaining({ operationId: queued.operationId }),
      );
    }
  } finally {
    first.response.resolve(fauxAssistantMessage("cleanup"));
    second.response.resolve(fauxAssistantMessage("cleanup"));
  }
}, 30000);
