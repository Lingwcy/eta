import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
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
