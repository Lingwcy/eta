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

async function connect(capabilities: string[] = ["code-diff"]) {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-diff-"));
  roots.push(root);
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    if (path === "/v1/status") return Response.json({ capabilities });
    if (path === "/v1/library")
      return Response.json({
        projects: [],
        workspaces: [],
        threads: [],
        models: [],
        settings: { defaultThinkingLevel: "off" },
      });
    throw new Error("Unexpected request: " + path);
  });
  const bot = new DesktopBot(root);
  await bot.connect({ url: "http://localhost:8080", token: "original" });
  request.mockClear();
  const prefix =
    "bot:" + createHash("sha256").update("http://localhost:8080").digest("hex").slice(0, 16) + ":";
  return { bot, request, prefix };
}

test("an older Bot explicitly refuses code diff without a request or local fallback", async () => {
  const { bot, request, prefix } = await connect([]);
  try {
    await expect(
      bot.workspaceChanges({ workspaceId: prefix + "workspace", scope: "all" }),
    ).rejects.toThrow("不支持此功能");
    await expect(
      bot.workspaceFileDiff({
        workspaceId: prefix + "workspace",
        scope: "all",
        entryId: "file",
        expectedRevision: "revision",
      }),
    ).rejects.toThrow("不支持此功能");
    await expect(
      bot.fileChangeDiff({ threadId: prefix + "thread", changeId: "change" }),
    ).rejects.toThrow("不支持此功能");
    expect(request).not.toHaveBeenCalled();
  } finally {
    bot.close();
  }
});

test("code diff translates workspace and thread identities without changing opaque entry or change IDs", async () => {
  const { bot, request, prefix } = await connect();
  const patch = { status: "ready", path: "file.ts", patch: "@@ -1 +1 @@\n-before\n+after\n" };
  try {
    request.mockResolvedValueOnce(
      Response.json({
        status: "ready",
        workspaceId: "workspace/slash",
        scope: "staged",
        revision: "revision",
        files: [],
      }),
    );
    await expect(
      bot.workspaceChanges({ workspaceId: prefix + "workspace/slash", scope: "staged" }),
    ).resolves.toMatchObject({ workspaceId: prefix + "workspace/slash", revision: "revision" });
    expect(request.mock.calls[0]![0]).toBe(
      "http://localhost:8080/v1/workspaces/workspace%2Fslash/changes",
    );
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toEqual({ scope: "staged" });
    request.mockResolvedValueOnce(Response.json(patch));
    await expect(
      bot.workspaceFileDiff({
        workspaceId: prefix + "workspace",
        scope: "unstaged",
        entryId: "opaque/file",
        expectedRevision: "revision",
      }),
    ).resolves.toEqual(patch);
    expect(request.mock.calls[1]![0]).toBe("http://localhost:8080/v1/workspaces/workspace/diff");
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string)).toEqual({
      scope: "unstaged",
      entryId: "opaque/file",
      expectedRevision: "revision",
    });
    request.mockResolvedValueOnce(Response.json(patch));
    await expect(
      bot.fileChangeDiff({ threadId: prefix + "thread/slash", changeId: "opaque/change" }),
    ).resolves.toEqual(patch);
    expect(request.mock.calls[2]![0]).toBe(
      "http://localhost:8080/v1/threads/thread%2Fslash/file-change-diff",
    );
    expect(JSON.parse(request.mock.calls[2]![1]!.body as string)).toEqual({
      changeId: "opaque/change",
    });
    expect(
      request.mock.calls.every(
        ([, init]) => (init!.headers as Record<string, string>).authorization === "Bearer original",
      ),
    ).toBe(true);
    await expect(
      bot.workspaceChanges({ workspaceId: "local-workspace", scope: "all" }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    bot.close();
  }
});

test.each(["workspace", "file", "history"] as const)(
  "a late %s diff cannot cross same-URL token replacement",
  async (kind) => {
    const { bot, request, prefix } = await connect();
    const original = request.getMockImplementation()!;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const patch = { status: "ready", path: "file.ts", patch: "private old data" };
    request.mockImplementation(async (input, init) => {
      const path = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      ).pathname;
      if (
        path.endsWith("/changes") ||
        path.endsWith("/diff") ||
        path.endsWith("/file-change-diff")
      ) {
        entered.resolve();
        await release.promise;
        return Response.json(
          kind === "workspace"
            ? {
                status: "ready",
                workspaceId: "workspace",
                scope: "all",
                revision: "old",
                files: [],
              }
            : patch,
        );
      }
      return original(input, init);
    });
    const pending =
      kind === "workspace"
        ? bot.workspaceChanges({ workspaceId: prefix + "workspace", scope: "all" })
        : kind === "file"
          ? bot.workspaceFileDiff({
              workspaceId: prefix + "workspace",
              scope: "all",
              entryId: "file",
              expectedRevision: "old",
            })
          : bot.fileChangeDiff({ threadId: prefix + "thread", changeId: "change" });
    const rejected = expect(pending).rejects.toThrow();
    try {
      await entered.promise;
      await bot.connect({ url: "http://localhost:8080", token: "replacement" });
      release.resolve();
      await rejected;
      request.mockResolvedValueOnce(Response.json(patch));
      await expect(
        bot.fileChangeDiff({ threadId: prefix + "thread", changeId: "current" }),
      ).resolves.toEqual(patch);
      expect((request.mock.calls.at(-1)![1]!.headers as Record<string, string>).authorization).toBe(
        "Bearer replacement",
      );
    } finally {
      release.resolve();
      await pending.catch(() => {});
      bot.close();
    }
  },
);

test.each(["disconnect", "close"] as const)(
  "a history diff admitted before %s cannot return after its owner ends",
  async (action) => {
    const { bot, request, prefix } = await connect();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    request.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ status: "ready", path: "private.ts", patch: "old content" });
    });
    const pending = bot.fileChangeDiff({ threadId: prefix + "thread", changeId: "change" });
    const rejected = expect(pending).rejects.toThrow();
    try {
      await entered.promise;
      if (action === "disconnect") await bot.disconnect();
      else bot.close();
      release.resolve();
      await rejected;
    } finally {
      release.resolve();
      await pending.catch(() => {});
      bot.close();
    }
  },
);
