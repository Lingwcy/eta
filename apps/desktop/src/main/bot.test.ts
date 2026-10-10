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

async function connect(supported: boolean) {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-compatibility-"));
  roots.push(root);
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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
