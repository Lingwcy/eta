import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ThreadAgentClient } from "../../renderer/src/agent/client.ts";
import type { SessionResponse, SnapshotResponse } from "@eta/core/agent/protocol";
import { DesktopBot } from "./bot.ts";
import { DraftThread } from "../../renderer/src/agent/draft-thread.ts";
import { commandReply } from "./ipc.ts";

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

function createdSession(): SessionResponse {
  return {
    id: "created-thread",
    model: {
      provider: "test",
      id: "one",
      name: "One",
      contextWindow: 10000,
      thinkingLevels: ["off"],
    },
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [],
      operation: null,
      lastResult: null,
      faulted: false,
    },
    contextTokens: 0,
  };
}

test("a cloud temporary workspace keeps null project ownership and prefixes its execution identity", async () => {
  const { bot, request, prefix } = await connect(true, ["temporary-workspace"]);
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (input, init) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/v1/threads") {
      expect(JSON.parse(init!.body as string)).toMatchObject({
        workspaceId: null,
        requestId: "temporary-request",
      });
      return Response.json({ ...createdSession(), workspaceId: "temporary" });
    }
    if (path === "/v1/library")
      return Response.json({
        projects: [],
        threads: [],
        models: [],
        workspaces: [
          { id: "temporary", kind: "temporary", projectId: null, cwd: "/temporary", createdAt: 1 },
        ],
        settings: { defaultThinkingLevel: "off" },
        allowedSandboxModes: ["workspace-write"],
      });
    return original(input, init);
  });
  try {
    const created = await bot.create(null, "temporary-request");
    expect(created.workspaceId).toBe(prefix + "temporary");
    await expect
      .poll(() => bot.status().library?.workspaces)
      .toMatchObject([{ id: prefix + "temporary", kind: "temporary", projectId: null }]);
  } finally {
    await bot.disconnect();
  }
});

test("an older Bot rejects temporary creation before issuing a request", async () => {
  const { bot, request } = await connect(true, []);
  try {
    await expect(bot.create(null, "temporary-request")).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  } finally {
    await bot.disconnect();
  }
});

test.each(["library", "status"])(
  "a cloud draft sends its first message while the post-create %s read is held",
  async (held) => {
    const { bot, request, prefix } = await connect(true);
    const original = request.getMockImplementation()!;
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const session = createdSession();
    const library = {
      ...bot.status().library!,
      threads: [
        {
          id: session.id,
          workspaceId: "workspace",
          title: "Created",
          createdAt: 1,
          sessionRef: {
            backendId: "eta" as const,
            metadata: {
              id: "session",
              createdAt: 1,
              storageVersion: 1,
              cwd: "/cloud",
              path: "/data/session",
              modifiedAt: 1,
            },
          },
        },
      ],
    };
    let sent = 0;
    request.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/threads") return Response.json(session);
      if (path === "/v1/threads/created-thread/messages") {
        sent++;
        return Response.json({ operationId: "run", kind: "run", startedAt: 1 });
      }
      if (path === "/v1/" + held) {
        entered.resolve();
        await release.promise;
      }
      return path === "/v1/library" ? Response.json(library) : original(input, init);
    });
    const published = vi.fn();
    const stop = bot.subscribe(published);
    const created = vi.fn();
    const draft = new DraftThread(
      "first-message",
      {
        createThread: (workspace, requestId, configuration) =>
          bot.create(workspace, requestId, configuration),
        submit: (id, prompt, images, requestId) => bot.submit(id, prompt, requestId, images),
      },
      created,
    );
    const sending = draft.submit(prefix + "workspace", "Hello", undefined, {
      provider: "test",
      modelId: "one",
      thinkingLevel: "off",
      sandboxMode: "workspace-write",
    });
    try {
      await entered.promise;
      await expect.poll(() => sent).toBe(1);
      expect(created).toHaveBeenCalledExactlyOnceWith(
        prefix + session.id,
        prefix + "workspace",
        false,
      );
      await expect(sending).resolves.toBe(prefix + session.id);
      expect(published).not.toHaveBeenCalled();
      expect(bot.status().library?.threads).toEqual([]);
      const paths = request.mock.calls.map(([url]) => new URL(String(url)).pathname);
      expect(paths.filter((path) => path === "/v1/threads")).toHaveLength(1);
      expect(paths.some((path) => path.endsWith("/configure") || path.endsWith("/sandbox"))).toBe(
        false,
      );
      release.resolve();
      await expect.poll(() => published.mock.calls.length).toBe(1);
      expect(bot.status().library?.threads[0]?.id).toBe(prefix + session.id);
    } finally {
      release.resolve();
      await sending.catch(() => {});
      await bot.refresh();
      stop();
      bot.close();
    }
  },
);

test("a failed post-create directory read does not fail the accepted first message", async () => {
  const { bot, request, prefix } = await connect(true);
  const original = request.getMockImplementation()!;
  let sent = 0;
  request.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/threads") return Response.json(createdSession());
    if (path === "/v1/threads/created-thread/messages") {
      sent++;
      return Response.json({ operationId: "run", kind: "run", startedAt: 1 });
    }
    if (path === "/v1/library") throw new TypeError("catalog unavailable");
    return original(input, init);
  });
  const draft = new DraftThread("catalog-failed", {
    createThread: (workspace, requestId) => bot.create(workspace, requestId),
    submit: (id, prompt, images, requestId) => bot.submit(id, prompt, requestId, images),
  });
  try {
    await expect(draft.submit(prefix + "workspace", "Hello")).resolves.toBe(
      prefix + "created-thread",
    );
    expect(sent).toBe(1);
    await expect.poll(() => bot.status().status).toBe("error");
    expect(bot.status().message).toContain("catalog unavailable");
    request.mockImplementation(original);
    await bot.refresh();
    expect(bot.status().status).toBe("connected");
  } finally {
    bot.close();
  }
});

test("creation returns during an older catalog read and schedules a fresh read after it", async () => {
  const { bot, request, prefix } = await connect(true);
  const original = request.getMockImplementation()!;
  const release = Promise.withResolvers<void>();
  const library = bot.status().library!;
  let reads = 0;
  request.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/threads") return Response.json(createdSession());
    if (path === "/v1/library") {
      reads++;
      if (reads === 1) await release.promise;
      return Response.json(reads === 1 ? library : { ...library, workspaceRoot: "/fresh-catalog" });
    }
    return original(input, init);
  });
  const older = bot.refresh();
  const creating = bot.create(prefix + "workspace", "new-during-refresh");
  try {
    await expect(creating).resolves.toMatchObject({ id: prefix + "created-thread" });
    expect(reads).toBe(1);
    release.resolve();
    await older;
    await expect.poll(() => bot.status().library?.workspaceRoot).toBe("/fresh-catalog");
    expect(reads).toBe(2);
  } finally {
    release.resolve();
    await older;
    await creating.catch(() => {});
    await bot.refresh();
    bot.close();
  }
});

test.each(["close", "disconnect", "switch", "credentials"])(
  "a queued creation refresh cannot restart after %s",
  async (action) => {
    const { bot, request, prefix } = await connect(true);
    const original = request.getMockImplementation()!;
    const release = Promise.withResolvers<void>();
    let first = true;
    request.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/threads") return Response.json(createdSession());
      if (path === "/v1/library" && first) {
        first = false;
        await release.promise;
      }
      return original(input, init);
    });
    const older = bot.refresh();
    try {
      await bot.create(prefix + "workspace", "queued-refresh");
      if (action === "close") bot.close();
      else if (action === "disconnect") await bot.disconnect();
      else
        await bot.connect({
          url: action === "switch" ? "http://localhost:8081" : "http://localhost:8080",
          token: "replacement",
        });
      const current = bot.status();
      request.mockClear();
      release.resolve();
      await older;
      // Both the old refresh and its queued continuation settle before the check-phase barrier.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(request).not.toHaveBeenCalled();
      expect(bot.status()).toBe(current);
    } finally {
      release.resolve();
      await older;
      bot.close();
    }
  },
);

test.each(["close", "disconnect", "switch", "credentials"])(
  "a creation reply after %s is not remapped or followed by a catalog read",
  async (action) => {
    const { bot, request, prefix } = await connect(true);
    const original = request.getMockImplementation()!;
    const release = Promise.withResolvers<Response>();
    request.mockImplementation((input, init) =>
      new URL(String(input)).pathname === "/v1/threads" ? release.promise : original(input, init),
    );
    const creating = bot.create(prefix + "workspace", "obsolete-create");
    const rejected = expect(creating).rejects.toThrow("原来的 Bot");
    try {
      if (action === "close") bot.close();
      else if (action === "disconnect") await bot.disconnect();
      else
        await bot.connect({
          url: action === "switch" ? "http://localhost:8081" : "http://localhost:8080",
          token: "replacement",
        });
      const current = bot.status();
      request.mockClear();
      release.resolve(Response.json(createdSession()));
      await rejected;
      expect(request).not.toHaveBeenCalled();
      expect(bot.status()).toBe(current);
    } finally {
      release.resolve(Response.json(createdSession()));
      await creating.catch(() => {});
      bot.close();
    }
  },
);

test("failed creation does not trigger a catalog refresh", async () => {
  const { bot, request, prefix } = await connect(true);
  request.mockResolvedValue(
    Response.json({ error: { message: "creation rejected" } }, { status: 400 }),
  );
  try {
    await expect(bot.create(prefix + "workspace", "failed")).rejects.toThrow("creation rejected");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toBe("http://localhost:8080/v1/threads");
  } finally {
    bot.close();
  }
});

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

test("operation reconciliation maps durable identities and rejects another Bot's operation ID", async () => {
  const { bot, request, prefix } = await connect(true);
  request.mockResolvedValue(
    Response.json({
      operationId: "42",
      inputEntryId: "12:0",
      originOperationId: "40",
      kind: "run",
      status: "completed",
      startedAt: 1000,
      messages: [],
    }),
  );
  try {
    expect(await bot.operation(prefix + "thread", prefix + "42")).toMatchObject({
      operationId: prefix + "42",
      inputEntryId: prefix + "12:0",
      originOperationId: prefix + "40",
      status: "completed",
    });
    expect(request.mock.calls[0]![0]).toBe("http://localhost:8080/v1/threads/thread/operations/42");
    request.mockClear();
    await expect(bot.operation(prefix + "thread", "bot:another:42")).rejects.toThrow("原来的 Bot");
    expect(request).not.toHaveBeenCalled();
  } finally {
    bot.close();
  }
});

test("a late operation response cannot be remapped after changing the Bot connection", async () => {
  const { bot, request, prefix } = await connect(true);
  const response = Promise.withResolvers<Response>();
  request.mockImplementationOnce(() => response.promise);
  const pending = bot.operation(prefix + "thread", prefix + "42");
  try {
    // Connecting again creates a new credential/client identity, including for the same URL.
    await bot.connect({ url: "http://localhost:8080", token: "replacement-token" });
    response.resolve(
      Response.json({
        operationId: "42",
        kind: "run",
        startedAt: 1000,
        status: "completed",
        messages: [],
      }),
    );
    await expect(pending).rejects.toThrow("原来的 Bot");
  } finally {
    response.resolve(Response.json({}));
    await pending.catch(() => {});
    bot.close();
  }
});

test.each([false, true])(
  "an unauthorized response rejects before reading its body (cancel fails=%s)",
  async (cancelFails) => {
    const { bot, request } = await connect(true);
    const read = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        pull() {
          read.resolve();
          return release.promise;
        },
        cancel() {
          cancelled = true;
          if (cancelFails) throw new Error("Body cancellation failed");
        },
      },
      { highWaterMark: 0 },
    );
    request.mockResolvedValue(new Response(body, { status: 401 }));
    const rejected = bot.request("/v1/library").then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    try {
      const outcome = await Promise.race([
        rejected,
        read.promise.then(() => ({ kind: "body-read" as const })),
      ]);
      expect(outcome.kind).toBe("error");
      if (outcome.kind !== "error") throw new Error("The client waited for an unauthorized body");
      expect(outcome.error).toBeInstanceOf(Error);
      expect(outcome.error).toMatchObject({ message: "Bot 令牌无效" });
      expect(cancelled).toBe(true);
    } finally {
      if (!cancelled) controller.close();
      release.resolve();
      await rejected;
      bot.close();
    }
  },
);

test.each([400, 503])("non-401 HTTP %s retains the server diagnostic", async (status) => {
  const { bot, request } = await connect(true);
  const response = Response.json(
    { error: { message: "Controlled server diagnostic" } },
    { status },
  );
  request.mockResolvedValue(response);
  try {
    await expect(bot.request("/v1/library")).rejects.toThrow("Controlled server diagnostic");
    expect(response.bodyUsed).toBe(true);
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

test.each(
  ["ordinary", "scheduled"].flatMap((delivery) =>
    [
      { framing: "LF", newline: "\n" },
      { framing: "CRLF", newline: "\r\n" },
      { framing: "CR", newline: "\r" },
    ].map((framing) => ({ delivery, ...framing })),
  ),
)(
  "$delivery Bot deliveries update an open thread through byte-split $framing SSE",
  async ({ delivery, newline }) => {
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
        toolIntents: { "opaque-call": "检查配置 你好" },
        operation: null,
        lastResult: null,
        faulted: false,
      },
    };
    const ready = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => ready.resolve(controller),
    });
    request.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/events")) {
        const controller = await ready.promise;
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
          once: true,
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
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
      operation: (id, operationId) => bot.operation(id, operationId),
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
      expect(client.getSnapshot().observation?.snapshot.toolIntents).toEqual({
        "opaque-call": "检查配置 你好",
      });
      const controller = await ready.promise;
      if (delivery === "ordinary") {
        await client.submit("Ordinary message 你好");
        expect(client.getSnapshot().admission).toMatchObject({
          operationId: prefix + "42",
          inputEntryId: prefix + "12:0",
        });
      }
      const bytes = new TextEncoder().encode(
        `event: snapshot\ndata: ${JSON.stringify({
          ...session,
          snapshot: {
            ...session.snapshot,
            transcript: [
              {
                id: "12:0",
                type: "message",
                message: { role: "user", content: "Ordinary message 你好", timestamp: 1000 },
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
        })}\n\n`.replaceAll("\n", newline),
      );
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      await expect
        .poll(() => client.getSnapshot().observation?.snapshot.lastResult?.operationId)
        .toBe(prefix + "42");
      expect(client.getSnapshot().admission).toBeNull();
      expect(client.getSnapshot().observation?.snapshot.toolIntents).toEqual({
        "opaque-call": "检查配置 你好",
      });
      expect(client.getSnapshot().observation?.snapshot.transcript[0].id).toBe(prefix + "12:0");
      expect(client.getSnapshot().observation?.snapshot.transcript[0].message.content).toBe(
        "Ordinary message 你好",
      );
    } finally {
      client.dispose();
      bot.close();
    }
  },
);

test.each([
  { framing: "LF", newline: "\n" },
  { framing: "CRLF", newline: "\r\n" },
  { framing: "CR", newline: "\r" },
])("schedule events refresh and reconnect on byte-split $framing", async ({ newline }) => {
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
  const publish = () => {
    const bytes = new TextEncoder().encode(
      `event: schedules\ndata: ${JSON.stringify({ revision })}\n\n`.replaceAll("\n", newline),
    );
    for (const byte of bytes) streams.at(-1)!.enqueue(Uint8Array.of(byte));
  };
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

test.each([
  [401, false],
  [403, false],
  [404, false],
  [408, true],
  [429, true],
  [500, true],
  [502, true],
  [503, true],
] as const)(
  "HTTP %s open failures retain retry policy in the serialized command reply",
  async (status, retryable) => {
    const { bot, request, prefix } = await connect(true);
    request.mockResolvedValue(Response.json({ error: { message: "upstream failed" } }, { status }));
    try {
      const reply = JSON.parse(
        JSON.stringify(await commandReply(() => bot.open(prefix + "thread"))),
      );
      expect(reply).toMatchObject({ ok: false, error: { code: "BotRequestFailed", retryable } });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      bot.close();
    }
  },
);

test("a network failure while opening a thread is retryable across the command boundary", async () => {
  const { bot, request, prefix } = await connect(true);
  request.mockRejectedValue(new TypeError("fetch failed"));
  try {
    await expect(commandReply(() => bot.open(prefix + "thread"))).resolves.toEqual({
      ok: false,
      error: { code: "BotRequestFailed", message: "fetch failed", retryable: true },
    });
  } finally {
    bot.close();
  }
});

test("an initial HTTP 502 recovers through the serialized command reply and client retry", async () => {
  const { bot, request, prefix } = await connect(true);
  const session: SessionResponse = {
    id: "thread",
    model: {
      id: "one",
      provider: "test",
      name: "One",
      contextWindow: 10000,
      thinkingLevels: ["off"],
    },
    contextTokens: 42,
    snapshot: {
      configuration: { model: { provider: "test", modelId: "one" }, thinkingLevel: "off" },
      transcript: [
        {
          id: "saved",
          type: "message",
          message: { role: "user", content: "Saved history", timestamp: 1 },
        },
      ],
      operation: null,
      lastResult: null,
      faulted: false,
    },
  };
  request
    .mockResolvedValueOnce(new Response("Bad gateway", { status: 502 }))
    .mockImplementation(async () => Response.json(session));
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(() => unsubscribe);
  const client = new ThreadAgentClient({
    openThread: (id) => bot.open(id),
    openThreadReply: async (id) => structuredClone(await commandReply(() => bot.open(id))),
    operation: (id, operationId) => bot.operation(id, operationId),
    configureThread: (id, provider, model, level) => bot.configure(id, provider, model, level),
    configureSandbox: (id, mode) => bot.configureSandbox(id, mode),
    submit: (id, prompt, images) => bot.submit(id, prompt, "request", images),
    stop: (id) => bot.command<void>(id, "stop"),
    subscribe,
  });
  vi.useFakeTimers();
  try {
    const connecting = client.connect(prefix + "thread");
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot().connection).toBe("connecting");
    expect(subscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await connecting;
    expect(request).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()).toMatchObject({
      connection: "connected",
      error: null,
      session: { id: prefix + "thread" },
    });
    expect(client.getSnapshot().observation?.snapshot.transcript[0]?.id).toBe(prefix + "saved");
    expect(client.getSnapshot().observation?.contextTokens).toBe(42);
  } finally {
    client.dispose();
    bot.close();
    vi.useRealTimers();
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test.each([true, false])(
  "thread body failures retry only transport errors (transport=%s)",
  async (transport) => {
    const { bot, request, prefix } = await connect(true);
    request.mockImplementation(async () =>
      transport
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("terminated"));
              },
            }),
          )
        : new Response("invalid JSON"),
    );
    try {
      const reply = await commandReply(() => bot.open(prefix + "thread"));
      expect(reply).toMatchObject({
        ok: false,
        error: { code: transport ? "BotRequestFailed" : "InternalError", retryable: transport },
      });
    } finally {
      bot.close();
    }
  },
);

test.each(["headers", "body", "partial", "snapshot"])(
  "a stalled SSE %s is aborted and reconnects to a fresh snapshot",
  async (phase) => {
    const { bot, request, prefix } = await connect(true);
    const original = request.getMockImplementation()!;
    const signals: AbortSignal[] = [];
    const cleanup = Promise.withResolvers<void>();
    const cancelled = vi.fn(() => cleanup.promise);
    const received: SnapshotResponse[] = [];
    const errors: string[] = [];
    const pending = Promise.withResolvers<Response>();
    request.mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/events")) return original(input, init);
      signals.push(init!.signal!);
      if (signals.length === 1 && phase === "headers") return pending.promise;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (signals.length > 1 || phase === "snapshot")
              controller.enqueue(
                new TextEncoder().encode(
                  "event: snapshot\ndata: " +
                    JSON.stringify({
                      contextTokens: signals.length > 1 ? 42 : 1,
                      snapshot: {
                        configuration: {
                          model: { provider: "test", modelId: "one" },
                          thinkingLevel: "off",
                        },
                        transcript: [],
                        operation: null,
                        lastResult: null,
                        faulted: false,
                      },
                    }) +
                    "\n\n",
                ),
              );
            else if (phase === "partial")
              controller.enqueue(new TextEncoder().encode("event: snapshot\ndata: {"));
          },
          cancel: cancelled,
        }),
      );
    });
    vi.useFakeTimers();
    const stop = await bot.subscribeThread(
      prefix + "thread",
      (value) => {
        received.push(value);
      },
      (error) => errors.push(error),
    );
    try {
      await vi.advanceTimersByTimeAsync(44999);
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(errors).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(signals).toHaveLength(2);
      expect(received.at(-1)?.contextTokens).toBe(42);
      if (phase !== "headers") expect(cancelled).toHaveBeenCalledTimes(1);
      pending.resolve(new Response(new ReadableStream({ cancel: cancelled })));
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toHaveLength(phase === "snapshot" ? 2 : 1);
      if (phase === "headers") expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      bot.close();
      pending.resolve(new Response());
      cleanup.resolve();
      vi.useRealTimers();
    }
  },
);

test("heartbeat frames keep an otherwise idle thread observation alive", async () => {
  const { bot, request, prefix } = await connect(true);
  const original = request.getMockImplementation()!;
  const signals: AbortSignal[] = [];
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancelled = vi.fn();
  request.mockImplementation(async (input, init) => {
    if (!String(input).endsWith("/events")) return original(input, init);
    signals.push(init!.signal!);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          stream = value;
        },
        cancel: cancelled,
      }),
    );
  });
  const received = vi.fn();
  const failed = vi.fn();
  vi.useFakeTimers();
  const stop = await bot.subscribeThread(prefix + "thread", received, failed);
  try {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(15000);
      stream.enqueue(new TextEncoder().encode("event: heartbeat\ndata: {}\n\n"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    stop();
    bot.close();
    vi.useRealTimers();
  }
});

test.each(["unsubscribe", "close", "disconnect", "switch"])(
  "%s during the first-frame wait cancels its deadline without reconnecting",
  async (action) => {
    const { bot, request, prefix } = await connect(true);
    const original = request.getMockImplementation()!;
    const signals: AbortSignal[] = [];
    const cancelled = vi.fn();
    const failed = vi.fn();
    request.mockImplementation(async (input, init) => {
      if (!String(input).endsWith("/events")) return original(input, init);
      signals.push(init!.signal!);
      return new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }));
    });
    vi.useFakeTimers();
    const stop = await bot.subscribeThread(prefix + "thread", () => {}, failed);
    try {
      await vi.advanceTimersByTimeAsync(30000);
      if (action === "unsubscribe") stop();
      else if (action === "close") bot.close();
      else if (action === "disconnect") await bot.disconnect();
      else await bot.connect({ url: "http://localhost:8081", token: "replacement" });
      await vi.advanceTimersByTimeAsync(90000);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    } finally {
      stop();
      bot.close();
      vi.useRealTimers();
    }
  },
);

test("a silent schedule stream reconnects and refreshes the authoritative revision", async () => {
  const { bot, request } = await connect(true, ["schedules"]);
  const original = request.getMockImplementation()!;
  const signals: AbortSignal[] = [];
  const cleanup = Promise.withResolvers<void>();
  const cancelled = vi.fn(() => cleanup.promise);
  const releaseRefresh = Promise.withResolvers<void>();
  let refreshing = false;
  request.mockImplementation(async (input, init) => {
    if (String(input).endsWith("/v1/schedules/events")) {
      signals.push(init!.signal!);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (signals.length > 1)
              controller.enqueue(
                new TextEncoder().encode('event: schedules\ndata: {"revision":2}\n\n'),
              );
          },
          cancel: cancelled,
        }),
      );
    }
    if (String(input).endsWith("/v1/schedules")) {
      refreshing = true;
      await releaseRefresh.promise;
      return Response.json({
        revision: 2,
        schedules: [],
        proposals: [],
        requests: [],
        lifecycleIntents: [],
      });
    }
    return original(input, init);
  });
  // Keep polling intervals real: only the stream should initiate this revision refresh.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const changed = vi.fn();
  const stop = bot.subscribeSchedules(changed);
  try {
    await vi.advanceTimersByTimeAsync(45000);
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(signals).toHaveLength(2);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(refreshing).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    releaseRefresh.resolve();
    // Backoff completion starts the refresh; its response and durable cache write finish separately.
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect((await bot.scheduleSnapshot())?.data.revision).toBe(2);
    stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(signals[1]!.aborted).toBe(true);
    expect(signals).toHaveLength(2);
  } finally {
    stop();
    bot.close();
    releaseRefresh.resolve();
    cleanup.resolve();
    vi.useRealTimers();
  }
});

test("a burst of schedule events coalesces the library refresh", async () => {
  const { bot, request } = await connect(true, ["schedules"]);
  let library = 0;
  let gate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/schedules/events"))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
        }),
      );
    if (url.endsWith("/v1/schedules"))
      return Response.json({
        revision: 1,
        schedules: [],
        proposals: [],
        requests: [],
        lifecycleIntents: [],
      });
    if (url.endsWith("/v1/library")) {
      library += 1;
      if (gate) await gate.promise;
    }
    return original(input, init);
  });
  const stop = bot.subscribeSchedules(() => {});
  const publish = () => {
    streams.at(-1)!.enqueue(new TextEncoder().encode('event: schedules\ndata: {"revision":1}\n\n'));
  };
  try {
    gate = Promise.withResolvers();
    publish();
    await expect.poll(() => library).toBe(1);
    for (let index = 0; index < 5; index += 1) publish();
    gate.resolve();
    gate = undefined;
    await expect
      .poll(async () => {
        const seen = library;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return library === seen ? seen : -1;
      })
      .toBeGreaterThan(0);
    expect(library).toBeLessThanOrEqual(2);
  } finally {
    stop();
    bot.close();
  }
});

test("thread views share one stream, replay its latest snapshot and release only the last owner", async () => {
  const { bot, request, prefix } = await connect(true);
  const original = request.getMockImplementation()!;
  const streams: { stream: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }[] =
    [];
  request.mockImplementation(async (input, init) => {
    if (
      !(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes(
        "/events",
      )
    )
      return original(input, init);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          streams.push({ stream, signal: init!.signal! });
        },
      }),
    );
  });
  const first = vi.fn();
  const second = vi.fn();
  const third = vi.fn();
  const failed = vi.fn();
  const stopFirst = await bot.subscribeThread(prefix + "thread", first, failed);
  const stopSecond = await bot.subscribeThread(prefix + "thread", second, failed);
  const emit = (index: number, tokens: number) =>
    streams[index]!.stream.enqueue(
      new TextEncoder().encode(
        `event: snapshot\ndata: ${JSON.stringify({ snapshot: createdSession().snapshot, contextTokens: tokens })}\n\n`,
      ),
    );
  try {
    await expect.poll(() => streams.length).toBe(1);
    emit(0, 42);
    await expect.poll(() => second.mock.calls.length).toBe(1);
    expect(first.mock.calls[0]![0].contextTokens).toBe(42);
    const stopThird = await bot.subscribeThread(prefix + "thread", third, failed);
    await expect.poll(() => third.mock.calls.length).toBe(1);
    expect(streams).toHaveLength(1);
    stopFirst();
    stopFirst();
    emit(0, 43);
    await expect.poll(() => third.mock.calls.length).toBe(2);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
    expect(streams[0]!.signal.aborted).toBe(false);
    stopThird();
    expect(streams[0]!.signal.aborted).toBe(true);
    const replacement = vi.fn();
    const stopReplacement = await bot.subscribeThread(prefix + "thread", replacement, failed);
    await expect.poll(() => streams.length).toBe(2);
    stopThird();
    expect(streams[1]!.signal.aborted).toBe(false);
    expect(replacement).not.toHaveBeenCalled();
    emit(1, 44);
    await expect.poll(() => replacement.mock.calls.length).toBe(1);
    expect(replacement.mock.calls[0]![0].contextTokens).toBe(44);
    stopReplacement();
    expect(failed).not.toHaveBeenCalled();
  } finally {
    stopFirst();
    stopSecond();
    bot.close();
  }
});

test("shared streams keep subagent paths separate and a failing consumer cannot disconnect its peers", async () => {
  const { bot, request, prefix } = await connect(true);
  const original = request.getMockImplementation()!;
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  request.mockImplementation(async (input, init) => {
    if (
      !(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes(
        "/events",
      )
    )
      return original(input, init);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          streams.set(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            stream,
          );
        },
      }),
    );
  });
  const failed = vi.fn();
  const good = vi.fn();
  await bot.subscribeThread(
    prefix + "thread",
    () => {
      throw new Error("view closed");
    },
    () => {
      throw new Error("disposed");
    },
  );
  await bot.subscribeThread(prefix + "thread", good, failed);
  const child = vi.fn();
  await bot.subscribeThread(prefix + "thread", child, failed, "/child");
  try {
    await expect.poll(() => streams.size).toBe(2);
    const frame = new TextEncoder().encode(
      `event: snapshot\ndata: ${JSON.stringify({ snapshot: createdSession().snapshot, contextTokens: 1 })}\n\n`,
    );
    for (const stream of streams.values()) stream.enqueue(frame);
    await expect.poll(() => good.mock.calls.length).toBe(1);
    await expect.poll(() => child.mock.calls.length).toBe(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    bot.close();
  }
});
