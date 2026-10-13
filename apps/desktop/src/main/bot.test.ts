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
