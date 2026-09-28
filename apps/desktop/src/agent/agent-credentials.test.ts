import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readAgentCredentials } from "./agent-credentials.ts";
import { MemoryHarnessService } from "./memory-harness.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(content?: string) {
  const directory = await mkdtemp(join(tmpdir(), "eta-auth-"));
  directories.push(directory);
  const path = join(directory, "auth.json");
  if (content !== undefined) await writeFile(path, content);
  return { path, credentials: await readAgentCredentials(path) };
}

test("pi API key makes the configured OpenCode model available without env authentication", async () => {
  const content = JSON.stringify({ "opencode-go": { type: "api_key", key: "test-only-key" } });
  const { path, credentials } = await fixture(content);
  const models = builtinModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  expect((await models.getAuth("opencode-go"))?.auth.apiKey).toBe("test-only-key");
  const service = new MemoryHarnessService(models, process.cwd(), async () => ({
    defaultProvider: "opencode-go",
    defaultModel: "deepseek-v4-flash",
    defaultThinkingLevel: "high",
  }));
  try {
    const session = await service.create();
    expect(session.model).toMatchObject({ provider: "opencode-go", id: "deepseek-v4-flash" });
    expect(session.snapshot.configuration.thinkingLevel).toBe("high");
    expect(await readFile(path, "utf8")).toBe(content);
  } finally {
    await service.close();
  }
});

test("stored credentials take precedence and a missing auth file retains env fallback", async () => {
  const saved = await fixture(
    JSON.stringify({
      "opencode-go": { type: "api_key", key: "stored-key" },
    }),
  );
  const missing = await fixture();
  const authContext = {
    env: async (name: string) => (name === "OPENCODE_API_KEY" ? "env-key" : undefined),
    fileExists: async () => false,
  };
  expect(
    (await builtinModels({ credentials: saved.credentials, authContext }).getAuth("opencode-go"))
      ?.auth.apiKey,
  ).toBe("stored-key");
  expect(
    (await builtinModels({ credentials: missing.credentials, authContext }).getAuth("opencode-go"))
      ?.auth.apiKey,
  ).toBe("env-key");
});

test("OAuth credentials refresh once in memory without modifying the shared auth file", async () => {
  const content = JSON.stringify({
    "oauth-test": { type: "oauth", refresh: "old-refresh", access: "old-access", expires: 0 },
  });
  const { path, credentials } = await fixture(content);
  const models = createModels({ credentials });
  const provider = fauxProvider({ provider: "oauth-test" }).provider;
  let refreshes = 0;
  models.setProvider({
    ...provider,
    auth: {
      oauth: {
        name: "Test OAuth",
        login: async () => {
          throw new Error("Login should not run");
        },
        refresh: async (current) => {
          refreshes++;
          return {
            ...current,
            access: "new-access",
            refresh: "new-refresh",
            expires: Date.now() + 3_600_000,
          };
        },
        toAuth: async (current) => ({ apiKey: current.access }),
      },
    },
  });
  const resolved = await Promise.all([models.getAuth("oauth-test"), models.getAuth("oauth-test")]);
  expect(resolved.map((entry) => entry?.auth.apiKey)).toEqual(["new-access", "new-access"]);
  expect(refreshes).toBe(1);
  expect(await readFile(path, "utf8")).toBe(content);
});

test("imports provider-scoped env and preserves OAuth provider metadata", async () => {
  const oauth = {
    type: "oauth",
    access: "access",
    refresh: "refresh",
    expires: 42,
    accountId: "test",
  };
  const { credentials } = await fixture(
    JSON.stringify({
      cloud: { type: "api_key", env: { ACCOUNT_ID: "test-account" } },
      oauth,
    }),
  );
  expect(await credentials.read("cloud")).toEqual({
    type: "api_key",
    env: { ACCOUNT_ID: "test-account" },
  });
  expect(await credentials.read("oauth")).toEqual(oauth);
});

test.each([
  '{"secret": "private-fixture-value",',
  "[]",
  '{"opencode-go": {"type":"api_key", "key":42}}',
  '{"opencode-go": {"type":"api_key", "env":{"ACCOUNT_ID":42}}}',
  '{"opencode-go": {"type":"oauth", "access":"private-fixture-value"}}',
])("invalid auth files report errors without exposing credential contents: %s", async (content) => {
  const directory = await mkdtemp(join(tmpdir(), "eta-auth-"));
  directories.push(directory);
  const path = join(directory, "auth.json");
  await writeFile(path, content);
  let caught: unknown;
  try {
    await readAgentCredentials(path);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain(path);
  expect(String(caught)).not.toContain("private-fixture-value");
  expect((caught as Error).cause).toBeUndefined();
});
