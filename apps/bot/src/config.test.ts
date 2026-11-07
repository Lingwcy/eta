import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { loadBotConfig } from "./config.ts";
import { createBotApplication } from "./application.ts";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

test.each([
  ["leading space", " fake-private"],
  ["trailing space", "fake-private "],
  ["interior space", "fake-private value"],
  ["colon", "fake-private:value"],
  ["trailing LF", "fake-private\n"],
  ["trailing CR", "fake-private\r"],
  ["trailing tab", "fake-private\t"],
  ["Unicode line separator", "fake-private\u2028"],
  ["Unicode paragraph separator", "fake-private\u2029"],
  ["NUL", "fake-private\0"],
  ["non-ASCII", "fake-private令牌"],
  ["leading padding", "=fake-private"],
  ["interior padding", "fake-private=value"],
])("unusable bearer token is rejected without disclosure: %s", async (_name, adminToken) => {
  const { path } = await configuration({ adminToken });
  await expect(loadBotConfig(path)).rejects.toThrow("Bot configuration is unreadable or invalid");
  await expect(loadBotConfig(path)).rejects.not.toThrow("fake-private");
});

test.each(["a", "CaseSensitive_TOKEN.1", "AZaz09-._~+/===", "opaque=="])(
  "valid bearer token survives configuration and actual authentication unchanged: %s",
  async (adminToken) => {
    vi.stubGlobal("fetch", () => {
      throw new Error("Configuration authentication tests must stay offline");
    });
    const { path } = await configuration({ adminToken, projects: [] });
    const config = await loadBotConfig(path);
    expect(config.adminToken).toBe(adminToken);
    const application = await createBotApplication(config);
    try {
      expect(
        (
          await application.app.request("/v1/status", {
            headers: { authorization: "Bearer " + config.adminToken },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await application.app.request("/v1/status", {
            headers: { authorization: "Bearer wrong-valid-token" },
          })
        ).status,
      ).toBe(401);
    } finally {
      await application.close();
    }
  },
);

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
  { runtime: { defaultThinkingLevel: "off", agentMode: "invalid" } },
  { credentials: { anthropic: "ETA_TEST_KEY" } },
])(
  "invalid deployment configuration is rejected without echoing its contents: %j",
  async (overrides) => {
    const { path } = await configuration({ ...overrides, adminToken: "secret-value" });
    await expect(loadBotConfig(path)).rejects.toThrow("Bot configuration is unreadable or invalid");
    await expect(loadBotConfig(path)).rejects.not.toThrow("secret-value");
  },
);

test.each(["standard", "codemode"])(
  "Bot runtime preserves the explicit %s mode",
  async (agentMode) => {
    const { path } = await configuration({ runtime: { defaultThinkingLevel: "off", agentMode } });
    expect((await loadBotConfig(path)).runtime.agentMode).toBe(agentMode);
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

test("deployment ceilings must include the default sandbox mode", async () => {
  for (const overrides of [
    { allowedSandboxModes: [] },
    { allowedSandboxModes: ["read-only"] },
    {
      allowedSandboxModes: ["read-only", "workspace-write"],
      runtime: { defaultThinkingLevel: "off", defaultSandboxMode: "danger-full-access" },
    },
  ]) {
    const { path } = await configuration(overrides);
    await expect(loadBotConfig(path)).rejects.toThrow("default sandbox mode must be allowed");
  }
  const { path } = await configuration({
    allowedSandboxModes: ["read-only"],
    runtime: { defaultThinkingLevel: "off", defaultSandboxMode: "read-only" },
  });
  expect((await loadBotConfig(path)).runtime.defaultSandboxMode).toBe("read-only");
});

test("full access can be the default unless the deployment restricts it", async () => {
  const { path } = await configuration({
    runtime: { defaultThinkingLevel: "off", defaultSandboxMode: "danger-full-access" },
  });
  expect((await loadBotConfig(path)).runtime.defaultSandboxMode).toBe("danger-full-access");
});
