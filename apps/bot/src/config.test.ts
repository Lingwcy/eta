import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { loadBotConfig } from "./config.ts";
import { environmentCredentials } from "./credentials.ts";

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
      projects: [{ key: "support", rootPath: "repository" }],
      ...overrides,
    }),
  );
  return { root, path };
}

test("deployment paths resolve from the configuration file and secrets remain environment references", async () => {
  const { root, path } = await configuration({ credentials: { anthropic: "ETA_TEST_KEY" } });
  const config = await loadBotConfig(path);
  expect(config.dataRoot).toBe(join(root, "data"));
  expect(config.home).toBe(join(root, "data", "home"));
  expect(config.projects[0]?.rootPath).toBe(join(root, "repository"));
  expect(config.credentials).toEqual({ anthropic: "ETA_TEST_KEY" });
});

test.each([
  { port: 0 },
  { maxConcurrent: 33 },
  { shutdownGraceMs: -1 },
  { runtime: { defaultThinkingLevel: "off", updateChannel: "secret-value" } },
  { credentials: { anthropic: "" } },
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

test("credential adapters keep independent snapshots and do not discover unconfigured keys", async () => {
  vi.stubEnv("ETA_TEST_KEY", "first-key");
  vi.stubEnv("ETA_UNCONFIGURED_KEY", "unconfigured-key");
  const first = environmentCredentials({ anthropic: "ETA_TEST_KEY" });
  vi.stubEnv("ETA_TEST_KEY", "second-key");
  const second = environmentCredentials({ openai: "ETA_TEST_KEY" });
  expect(await first.read("anthropic")).toEqual({ type: "api_key", key: "first-key" });
  expect(await second.read("openai")).toEqual({ type: "api_key", key: "second-key" });
  expect(await first.read("openai")).toBeUndefined();
  expect(await second.read("anthropic")).toBeUndefined();
  expect(await environmentCredentials().list()).toEqual([]);
  expect(await first.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
});
