import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ThreadAgentClient } from "../../renderer/src/agent/client.ts";
import type { SessionResponse, SnapshotResponse } from "@eta/core/agent/protocol";
import { DesktopBot } from "./bot.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function connect(supported: boolean, capabilities?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-compatibility-"));
  roots.push(root);
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/status")) return Response.json({ capabilities });
    if (url.endsWith("/v1/library"))
      return Response.json({
        projects: [],
        workspaces: [],
        threads: [],
        models: [],
        settings: { defaultThinkingLevel: "off" },
        ...(supported ? { allowedSandboxModes: ["read-only", "workspace-write"] } : {}),
      });
    return Response.json({ id: "thread" });
  });
  const bot = new DesktopBot(root);
  await bot.connect({ url: "http://localhost:8080", token: "test-token" });
  request.mockClear();
  const prefix =
    "bot:" + createHash("sha256").update("http://localhost:8080").digest("hex").slice(0, 16) + ":";
  return { bot, request, prefix };
}

test("restoring a large thread can read its body beyond the ordinary request deadline", async () => {
  const { bot, request } = await connect(true);
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const controllers: AbortController[] = [];
  // Use controlled deadlines so the test exercises body cancellation without waiting two minutes.
  const deadline = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  request.mockImplementation(
    async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            streams.push(controller);
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
      ),
  );
  try {
    const ordinary = bot.request("/v1/library");
    const restored = bot.request<{ history: string }>("/v1/threads/thread");
    const timedOut = expect(ordinary).rejects.toThrow("连接 Bot 超时，请检查网络后重试。");
    controllers[0]!.abort(new DOMException("timeout", "TimeoutError"));
    await timedOut;
    streams[1]!.enqueue(new TextEncoder().encode(JSON.stringify({ history: "restored" })));
    streams[1]!.close();
    await expect(restored).resolves.toEqual({ history: "restored" });
    expect(deadline).toHaveBeenCalledWith(10000);
    expect(deadline).toHaveBeenCalledWith(120000);
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    bot.close();
  }
});

test("an older Bot reports sandbox incompatibility before changing or creating remote threads", async () => {
  const { bot, request, prefix } = await connect(false);
  await expect(bot.configureSandbox(prefix + "thread", "read-only")).rejects.toThrow(
    "当前 Bot 尚不支持沙盒，请更新 Bot 并重新连接",
  );
  await expect(
    bot.create(prefix + "workspace", "request", {
      provider: "test",
      modelId: "model",
      thinkingLevel: "off",
      sandboxMode: "workspace-write",
    }),
  ).rejects.toThrow("当前 Bot 尚不支持沙盒");
  expect(request).not.toHaveBeenCalled();
  expect(bot.status().status).toBe("connected");
  bot.close();
});

test("a compatible Bot still receives sandbox changes through the HTTP endpoint", async () => {
  const { bot, request, prefix } = await connect(true);
  const result = await bot.configureSandbox(prefix + "thread", "read-only");
  expect(result.id).toBe(prefix + "thread");
  const [url, init] = request.mock.calls[0]!;
  expect(url).toBe("http://localhost:8080/v1/threads/thread/sandbox");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(init?.body as string)).toEqual({ mode: "read-only" });
  bot.close();
});

test("an older Bot refuses worktree operations without sending them to another environment", async () => {
  const { bot, request, prefix } = await connect(true);
  try {
    await expect(
      bot.createWorktree({
        projectId: prefix + "project",
        baseWorkspaceId: prefix + "workspace",
        branch: { kind: "new", name: "eta/work" },
        requestId: "create",
      }),
    ).rejects.toThrow("不支持此功能");
    await expect(bot.gitRepository(prefix + "workspace")).rejects.toThrow("不支持此功能");
    expect(request).not.toHaveBeenCalled();
  } finally {
    bot.close();
  }
});

test("a Bot exposes capabilities immediately and translates worktree IDs on both sides of HTTP", async () => {
  const { bot, request, prefix } = await connect(true, ["git", "worktree", "approval-review", 42]);
  try {
    expect(bot.status().capabilities).toEqual(["git", "worktree", "approval-review"]);
    request.mockResolvedValueOnce(
      Response.json({
        projectId: "project",
        workspaceId: "created",
        continues: "prior",
        status: "ready",
      }),
    );
    const created = await bot.createWorktree({
      projectId: prefix + "project",
      baseWorkspaceId: prefix + "workspace",
      branch: { kind: "existing", name: "eta/work" },
      requestId: "create",
      continuesWorkspaceId: prefix + "prior",
    });
    expect(created).toMatchObject({
      projectId: prefix + "project",
      workspaceId: prefix + "created",
      continues: prefix + "prior",
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("http://localhost:8080/v1/projects/project/worktrees");
    expect(JSON.parse(init!.body as string)).toEqual({
      baseWorkspaceId: "workspace",
      branch: { kind: "existing", name: "eta/work" },
      requestId: "create",
      continuesWorkspaceId: "prior",
    });
    request.mockClear();
    request.mockResolvedValueOnce(
      Response.json({ projectId: "project", workspaceId: "created", status: "removed" }),
    );
    expect(await bot.removeWorktree(prefix + "created", "remove")).toMatchObject({
      workspaceId: prefix + "created",
      status: "removed",
    });
    expect(request.mock.calls[0]![0]).toBe("http://localhost:8080/v1/workspaces/created/remove");
  } finally {
    bot.close();
  }
});

test("remote GitHub queries translate IDs and cannot fall back to local execution on an older Bot", async () => {
  const { bot, request, prefix } = await connect(true, ["git", "github"]);
  try {
    const repository = {
      projectId: "project",
      workspaceId: "workspace",
      commonDir: "/git",
      remote: "origin",
      owner: "owner",
      repo: "repo",
    };
    request.mockResolvedValueOnce(
      Response.json({
        status: "ready",
        repository,
        identity: { authenticated: false, source: "anonymous" },
        items: [],
        fetchedAt: 1,
        stale: false,
      }),
    );
    expect(
      await bot.githubQuery({
        projectId: prefix + "project",
        kind: "issues",
        state: "open",
        cursor: "2",
      }),
    ).toMatchObject({
      status: "ready",
      repository: { projectId: prefix + "project", workspaceId: prefix + "workspace" },
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("http://localhost:8080/v1/projects/project/github");
    expect(JSON.parse(init!.body as string)).toEqual({
      kind: "issues",
      state: "open",
      cursor: "2",
    });
  } finally {
    bot.close();
  }
  const old = await connect(true);
  try {
    await expect(
      old.bot.githubQuery({ projectId: old.prefix + "project", kind: "pulls", state: "open" }),
    ).rejects.toThrow("不支持此功能");
    expect(old.request).not.toHaveBeenCalled();
  } finally {
    old.bot.close();
  }
});

test("schedule snapshots and receipts map all entity IDs while preserving opaque identities", async () => {
  const { bot, request, prefix } = await connect(true, ["schedules"]);
  const schedule = {
    id: "plan",
    threadId: "thread",
    workspaceId: "workspace",
    name: "Review",
    prompt: "Review code",
    rule: { type: "interval", everyMs: 300000, anchorAt: 0 },
    state: "active",
    nextRunAt: 300000,
    consumedThrough: null,
    revision: 1,
    missedWindowMs: 86400000,
    source: "user",
    createdAt: 1,
    updatedAt: 1,
  };
  const opaque = "bot:opaque:/request";
  const receipt = {
    requestId: opaque,
    threadId: "thread",
    workspaceId: "workspace",
    fingerprint: "opaque-fingerprint",
    state: "pending",
    change: { action: "pause", scheduleId: "plan", expectedRevision: 1 },
    scheduleId: "plan",
    proposalId: "proposal",
    occurrenceId: "run",
    createdAt: 1,
  };
  const occurrence = {
    id: "run",
    scheduleId: "plan",
    threadId: "thread",
    scheduleRevision: 1,
    scheduledAt: 300000,
    detectedAt: 300000,
    name: "Review",
    prompt: "Review code",
    rule: schedule.rule,
    requestId: opaque,
    operationId: "42",
    inputEntryId: "12:0",
    state: "admitted",
    source: "automatic",
  };
  const snapshot = {
    revision: 2,
    schedules: [schedule],
    proposals: [
      {
        id: "proposal",
        threadId: "thread",
        workspaceId: "workspace",
        change: receipt.change,
        contentFingerprint: "content-fingerprint",
        sourceIdentity: "root:call",
        state: "pending",
        createdAt: 1,
        expiresAt: 1000000,
      },
    ],
    requests: [receipt],
    occurrences: [occurrence],
    lifecycleIntents: [
      {
        requestId: opaque,
        threadId: "thread",
        workspaceId: "workspace",
        action: "archive",
        phase: "prepared",
        createdAt: 1,
      },
    ],
  };
  request.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/schedules")) return Response.json(snapshot);
    if (init?.method === "PATCH")
      return Response.json({ ...receipt, state: "applied", finishedAt: 2 });
    if (url.includes("/schedule-requests/")) return Response.json(receipt);
    if (url.endsWith("/runs")) return Response.json({ runs: [occurrence] });
    throw new Error("unexpected request");
  });
  try {
    const result = await bot.scheduleSnapshot();
    expect(result?.environment.status).toBe("connected");
    expect(result?.data.schedules[0]).toMatchObject({
      id: prefix + "plan",
      threadId: prefix + "thread",
      workspaceId: prefix + "workspace",
    });
    expect(result?.data.proposals[0]).toMatchObject({
      id: prefix + "proposal",
      change: { scheduleId: prefix + "plan" },
      contentFingerprint: "content-fingerprint",
    });
    expect(result?.data.requests[0]).toMatchObject({
      requestId: opaque,
      fingerprint: "opaque-fingerprint",
      occurrenceId: prefix + "run",
      proposalId: prefix + "proposal",
      change: { scheduleId: prefix + "plan" },
    });
    expect(result?.data.lifecycleIntents[0]).toMatchObject({
      requestId: opaque,
      threadId: prefix + "thread",
    });
    expect(result?.data.occurrences?.[0]).toMatchObject({
      id: prefix + "run",
      operationId: prefix + "42",
      inputEntryId: prefix + "12:0",
      requestId: opaque,
    });
    request.mockClear();
    const updated = await bot.writeSchedule({
      threadId: prefix + "thread",
      requestId: opaque,
      change: {
        action: "update",
        scheduleId: prefix + "plan",
        expectedRevision: 1,
        patch: { prompt: "New content" },
      },
    });
    expect(updated.scheduleId).toBe(prefix + "plan");
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("http://localhost:8080/v1/schedules/plan");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({
      requestId: opaque,
      expectedRevision: 1,
      patch: { prompt: "New content" },
    });
    expect((await bot.scheduleRequest(prefix + "thread", opaque)).requestId).toBe(opaque);
    expect((await bot.scheduleRuns(prefix + "plan"))[0].operationId).toBe(prefix + "42");
    request.mockRejectedValue(new Error("Disconnected"));
    const stale = await bot.scheduleSnapshot();
    expect(stale?.environment.status).toBe("offline");
    expect(stale?.environment.message).toContain("可能仍在执行");
    expect(stale?.data.schedules[0].id).toBe(prefix + "plan");
  } finally {
    bot.close();
  }
});

test("older Bot schedule reads report unsupported and writes never fall back to this computer", async () => {
  const { bot, request, prefix } = await connect(true, []);
  try {
    expect((await bot.scheduleSnapshot())?.environment.status).toBe("unsupported");
    await expect(
      bot.writeSchedule({
        threadId: prefix + "thread",
        requestId: "create",
        change: {
          action: "create",
          name: "Review",
          prompt: "Review",
          rule: { type: "once", at: Date.now() + 1000 },
        },
      }),
    ).rejects.toThrow("不支持此功能");
    expect(request).not.toHaveBeenCalled();
  } finally {
    bot.close();
  }
});

test.each(["ordinary", "scheduled"])(
  "%s Bot deliveries update an open thread through SSE",
  async (delivery) => {
    const { bot, request, prefix } = await connect(true, ["schedules"]);
    const session: SessionResponse = {
      id: "thread",
      model: {
        id: "one",
        provider: "test",
        name: "One",
        contextWindow: 10000,
        thinkingLevels: ["off"],
      },
      contextTokens: 0,
      snapshot: {
        configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
        transcript: [],
        operation: null,
        lastResult: null,
        faulted: false,
      },
    };
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => ready.resolve(controller),
    });
    request.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/events"))
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      if (url.endsWith("/messages"))
        return Response.json({
          operationId: "42",
          inputEntryId: "12:0",
          kind: "run",
          startedAt: 1000,
        });
      return Response.json(session);
    });
    const client = new ThreadAgentClient({
      openThread: (id) => bot.open(id),
      configureThread: (id, provider, modelId, level) =>
        bot.configure(id, provider, modelId, level),
      configureSandbox: (id, mode) => bot.configureSandbox(id, mode),
      submit: (id, prompt, images) => bot.submit(id, prompt, "opaque-request", images),
      stop: (id) => bot.command<void>(id, "stop"),
      subscribe: (id, listener) => {
        let disposed = false;
        let unsubscribe: (() => void) | undefined;
        void bot
          .subscribeThread(
            id,
            (value) => listener({ type: "snapshot", value }),
            (message) => listener({ type: "error", message }),
          )
          .then((stop) => {
            if (disposed) stop();
            else unsubscribe = stop;
          });
        return () => {
          disposed = true;
          unsubscribe?.();
        };
      },
    });
    try {
      await client.connect(prefix + "thread");
      const controller = await ready.promise;
      if (delivery === "ordinary") {
        await client.submit("Ordinary message");
        expect(client.getSnapshot().admission).toMatchObject({
          operationId: prefix + "42",
          inputEntryId: prefix + "12:0",
        });
      }
      controller.enqueue(
        new TextEncoder().encode(
          `event: snapshot\ndata: ${JSON.stringify({
            ...session,
            snapshot: {
              ...session.snapshot,
              transcript: [
                {
                  id: "12:0",
                  type: "message",
                  message: { role: "user", content: "Ordinary message", timestamp: 1000 },
                },
              ],
              lastResult: {
                operationId: "42",
                inputEntryId: "12:0",
                kind: "run",
                startedAt: 1000,
                endedAt: 2000,
                status: "completed",
                fromTipId: null,
                tipId: null,
              },
            },
          })}\n\n`,
        ),
      );
      await expect
        .poll(() => client.getSnapshot().observation?.snapshot.lastResult?.operationId)
        .toBe(prefix + "42");
      expect(client.getSnapshot().admission).toBeNull();
      expect(client.getSnapshot().observation?.snapshot.transcript[0].id).toBe(prefix + "12:0");
    } finally {
      client.dispose();
      bot.close();
    }
  },
);

test("schedule events refresh immediately, recover after reconnect and release the stream", async () => {
  const { bot, request } = await connect(true, ["schedules"]);
  let revision = 1;
  let heldSnapshot: Promise<Response> | undefined;
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let aborted = 0;
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/schedules/events"))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted++;
                controller.error(new Error("aborted"));
              },
              { once: true },
            );
          },
        }),
      );
    if (url.endsWith("/v1/schedules")) {
      if (heldSnapshot) {
        const response = heldSnapshot;
        heldSnapshot = undefined;
        return response;
      }
      return Response.json({
        revision,
        schedules: [],
        proposals: [],
        requests: [],
        lifecycleIntents: [],
      });
    }
    return original(input, init);
  });
  const revisions: number[] = [];
  const stop = bot.subscribeSchedules(() => {
    void bot.scheduleSnapshot().then((snapshot) => revisions.push(snapshot!.data.revision));
  });
  const publish = () =>
    streams
      .at(-1)!
      .enqueue(
        new TextEncoder().encode(`event: schedules\ndata: ${JSON.stringify({ revision })}\n\n`),
      );
  try {
    publish();
    await expect.poll(() => revisions).toContain(1);
    const previous = Promise.withResolvers<Response>();
    heldSnapshot = previous.promise;
    const stale = bot.scheduleSnapshot();
    revision = 2;
    publish();
    previous.resolve(
      Response.json({
        revision: 1,
        schedules: [],
        proposals: [],
        requests: [],
        lifecycleIntents: [],
      }),
    );
    await stale;
    await expect.poll(() => revisions).toContain(2);
    streams[0]!.close();
    await expect.poll(() => streams.length, { timeout: 4000 }).toBe(2);
    revision = 3;
    publish();
    await expect.poll(() => revisions).toContain(3);
    stop();
    await expect.poll(() => aborted).toBe(2);
    expect(streams.length).toBe(2);
  } finally {
    stop();
    bot.close();
  }
});

test("manual run acknowledges the durable receipt without waiting for a slow snapshot refresh", async () => {
  const { bot, request, prefix } = await connect(true, ["schedules"]);
  const snapshot = Promise.withResolvers<Response>();
  request.mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/run"))
      return Response.json({
        requestId: "manual",
        threadId: "thread",
        fingerprint: "opaque",
        state: "applied",
        scheduleId: "plan",
        occurrenceId: "run",
        createdAt: 1,
      });
    return snapshot.promise;
  });
  try {
    await expect(
      bot.runSchedule({
        threadId: prefix + "thread",
        scheduleId: prefix + "plan",
        requestId: "manual",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ occurrenceId: prefix + "run", state: "applied" });
  } finally {
    snapshot.resolve(
      Response.json({
        revision: 1,
        schedules: [],
        proposals: [],
        requests: [],
        lifecycleIntents: [],
      }),
    );
    await bot.scheduleSnapshot();
    bot.close();
  }
});

test.each(["unsubscribe", "close", "disconnect", "switch"])(
  "%s stops buffered SSE delivery after an asynchronous consumer resumes",
  async (action) => {
    const { bot, request, prefix } = await connect(true, ["schedules"]);
    const release = Promise.withResolvers<void>();
    const received: SnapshotResponse[] = [];
    let cancelled = false;
    const snapshot = (sequence: number): SnapshotResponse => ({
      contextTokens: sequence,
      snapshot: {
        configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
        transcript: [
          {
            id: "entry",
            type: "message",
            message: { role: "user", content: "old Bot", timestamp: 1 },
          },
        ],
        operation: null,
        lastResult: null,
        faulted: false,
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [1, 2]
              .map((sequence) => `event: snapshot\ndata: ${JSON.stringify(snapshot(sequence))}\n\n`)
              .join(""),
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith("/events") ? new Response(body) : original(input, init);
    });
    const onError = vi.fn();
    const stop = await bot.subscribeThread(
      prefix + "thread",
      async (value) => {
        received.push(value);
        if (received.length === 1) await release.promise;
      },
      onError,
    );
    try {
      await expect.poll(() => received.length).toBe(1);
      expect(received[0]!.snapshot.transcript[0]!.id).toBe(prefix + "entry");
      if (action === "unsubscribe") stop();
      else if (action === "close") bot.close();
      else if (action === "disconnect") await bot.disconnect();
      else await bot.connect({ url: "http://localhost:8081", token: "other-token" });
      release.resolve();
      await expect.poll(() => cancelled).toBe(true);
      expect(received.map((value) => value.contextTokens)).toEqual([1]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      stop();
      bot.close();
    }
  },
);
