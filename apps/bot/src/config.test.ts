import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { loadBotConfig } from "./config.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function configuration(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "eta-bot-config-"));
  directories.push(root);
  const path = join(root, "config.json");
  await writeFile(
    path,
    JSON.stringify({
      dataRoot: "data",
      adminToken: "fixture-token",
      runtime: { defaultThinkingLevel: "off" },
      workspaceRoot: "workspaces",
      projects: [{ key: "support", rootPath: "repository" }],
      ...overrides,
    }),
  );
  return { root, path };
}

test("deployment paths resolve from the configuration file", async () => {
  const { root, path } = await configuration();
  const config = await loadBotConfig(path);
  expect(config.dataRoot).toBe(join(root, "data"));
  expect(config.workspaceRoot).toBe(join(root, "workspaces"));
  expect(config.home).toBe(join(root, "data", "home"));
  expect(config.projects?.[0]?.rootPath).toBe(join(root, "repository"));
});

test.each([
  { workspaceRoot: undefined },
  { port: 0 },
  { maxConcurrent: 33 },
  { shutdownGraceMs: -1 },
  { runtime: { defaultThinkingLevel: "off", updateChannel: "secret-value" } },
  { credentials: { anthropic: "ETA_TEST_KEY" } },
])(
  "invalid deployment configuration is rejected without echoing its contents: %j",
  async (overrides) => {
    const { path } = await configuration({ ...overrides, adminToken: "secret-value" });
    await expect(loadBotConfig(path)).rejects.toThrow("Bot configuration is unreadable or invalid");
    await expect(loadBotConfig(path)).rejects.not.toThrow("secret-value");
  },
);

test("ambiguous project and channel mappings fail before runtime startup", async () => {
  const projects = await configuration({
    projects: [
      { key: "same", rootPath: "one" },
      { key: "same", rootPath: "two" },
    ],
  });
  await expect(loadBotConfig(projects.path)).rejects.toThrow("project keys must be unique");
  const channels = await configuration({
    discord: {
      tokenEnv: "ETA_TEST_DISCORD_TOKEN",
      channels: [
        { guildId: "1", channelId: "10", projectKey: "support" },
        { guildId: "1", channelId: "10", projectKey: "support" },
      ],
    },
  });
  await expect(loadBotConfig(channels.path)).rejects.toThrow("channel mappings must be unique");
});

test("workspaceRoot configuration does not require preconfigured projects", async () => {
  const { path, root } = await configuration({ projects: undefined });
  const config = await loadBotConfig(path);
  expect(config.workspaceRoot).toBe(join(root, "workspaces"));
  expect(config.projects).toEqual([]);
});
