import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { CredentialStore, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { CredentialService } from "@eta/core/service/credentials/index";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { expect, test, vi } from "vite-plus/test";
import { DesktopAuthentication } from "./index.ts";

const oauthCredential = {
  type: "oauth" as const,
  access: "private-access",
  refresh: "private-refresh",
  expires: Date.now() + 100000,
};

function setup(
  login: (interaction: ProviderAuthInteraction) => Promise<typeof oauthCredential> = async (
    interaction,
  ) => {
    await interaction.prompt({ type: "manual_code", message: "Paste callback" });
    return oauthCredential;
  },
  credentials: CredentialStore = new InMemoryCredentialStore(),
) {
  const models = createModels({ credentials });
  const provider = fauxProvider({ provider: "test" }).provider;
  models.setProvider({
    ...provider,
    auth: {
      oauth: {
        name: "Account",
        login,
        refresh: async (value) => value,
        toAuth: async (value) => ({ apiKey: value.access }),
      },
      apiKey: {
        name: "API Key",
        login: async (interaction) => {
          const key = await interaction.prompt({ type: "secret", message: "API Key" });
          const region = await interaction.prompt({
            type: "select",
            message: "Region",
            options: [{ id: "eu", label: "Europe" }],
          });
          return { type: "api_key", key, env: { REGION: region } };
        },
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key } } : undefined,
      },
    },
  });
  const open = vi.fn(async (_url: string) => {});
  const auth = new DesktopAuthentication(models, credentials, open, "installation-id");
  return { auth, credentials, models, open };
}

async function completed(auth: DesktopAuthentication, id: string) {
  await vi.waitFor(() => expect(auth.read(id).status).not.toBe("running"));
  return auth.read(id);
}

test("providers come from pi-ai capabilities, including all requested account login sources", () => {
  const credentials = new InMemoryCredentialStore();
  const models = builtinModels({ credentials });
  const auth = new DesktopAuthentication(models, credentials, async () => {}, "device");
  const providers = auth.providers();
  expect(providers.filter((p) => p.methods.includes("oauth")).map((p) => p.id)).toEqual(
    expect.arrayContaining([
      "anthropic",
      "github-copilot",
      "kimi-coding",
      "meta",
      "openai",
      "openai-codex",
      "openrouter",
      "radius",
      "xai",
    ]),
  );
  expect(providers.find((p) => p.id === "deepseek")?.methods).toContain("api_key");
  expect(providers.find((p) => p.id === "openai-codex")?.methods).not.toContain("api_key");
});

test("API Key login walks provider-specific prompts and persists key plus env only after completion", async () => {
  const { auth, credentials } = setup();
  const flow = auth.start("test", "api_key");
  expect(flow.prompt?.type).toBe("secret");
  auth.answer(flow.id, flow.prompt!.id, "private-api-key");
  await vi.waitFor(() => expect(auth.read(flow.id).prompt?.type).toBe("select"));
  expect(await credentials.read("test")).toBeUndefined();
  expect(() => auth.answer(flow.id, auth.read(flow.id).prompt!.id, "invalid")).toThrow(
    "请选择有效选项",
  );
  auth.answer(flow.id, auth.read(flow.id).prompt!.id, "eu");
  expect((await completed(auth, flow.id)).status).toBe("completed");
  expect(await credentials.read("test")).toEqual({
    type: "api_key",
    key: "private-api-key",
    env: { REGION: "eu" },
  });
  expect(JSON.stringify(auth.read(flow.id))).not.toContain("private-api-key");
});

test("account login opens device authorization, keeps code through progress, and replaces the old key", async () => {
  const { auth, credentials, open } = setup(async (interaction) => {
    interaction.notify({
      type: "device_code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.com/authorize",
    });
    interaction.notify({ type: "progress", message: "Waiting" });
    await interaction.prompt({ type: "manual_code", message: "Code" });
    return oauthCredential;
  });
  await credentials.modify("test", async () => ({ type: "api_key", key: "old-key" }));
  const flow = auth.start("test", "oauth");
  expect(open).toHaveBeenCalledWith("https://example.com/authorize");
  expect(flow.deviceCode).toBe("ABCD-EFGH");
  expect(flow.links).toHaveLength(1);
  await expect(auth.openLink(flow.id, "https://other.com")).rejects.toThrow("授权链接无效");
  auth.answer(flow.id, flow.prompt!.id, "code");
  expect((await completed(auth, flow.id)).status).toBe("completed");
  expect(await credentials.read("test")).toEqual(oauthCredential);
  expect(JSON.stringify(auth.read(flow.id))).not.toContain("private-access");
});

test("cancelled replacement preserves old credential and rejects late or duplicate answers", async () => {
  const { auth, credentials } = setup();
  await credentials.modify("test", async () => ({ type: "api_key", key: "old" }));
  const flow = auth.start("test", "oauth");
  expect(() => auth.start("test", "api_key")).toThrow("请先完成或取消当前登录");
  await auth.cancel(flow.id);
  expect(auth.read(flow.id).status).toBe("cancelled");
  expect(() => auth.answer(flow.id, flow.prompt!.id, "late")).toThrow("此登录步骤已结束");
  expect(await credentials.read("test")).toEqual({ type: "api_key", key: "old" });
  const next = auth.start("test", "oauth");
  expect(next.id).not.toBe(flow.id);
  await auth.close();
});

test("callback-winning prompt cancellation does not cancel a successful account login", async () => {
  const controller = new AbortController();
  const { auth, credentials } = setup(async (interaction) => {
    await interaction
      .prompt({ type: "manual_code", message: "Code", signal: controller.signal })
      .catch(() => {});
    return oauthCredential;
  });
  const flow = auth.start("test", "oauth");
  controller.abort();
  expect((await completed(auth, flow.id)).status).toBe("completed");
  expect(await credentials.read("test")).toEqual(oauthCredential);
});

test("login errors never expose provider secrets or replace stored credentials", async () => {
  const { auth, credentials } = setup(async () => {
    throw new Error("private-access private-key");
  });
  await credentials.modify("test", async () => ({ type: "api_key", key: "old" }));
  const flow = auth.start("test", "oauth");
  const state = await completed(auth, flow.id);
  expect(state.status).toBe("failed");
  expect(JSON.stringify(state)).not.toContain("private-");
  expect(await credentials.read("test")).toEqual({ type: "api_key", key: "old" });
});

test("unsupported methods are rejected and logout cannot remove another login method", async () => {
  const { auth, credentials } = setup();
  expect(() => auth.start("missing", "oauth")).toThrow("该服务不支持此登录方式");
  await credentials.modify("test", async () => ({ type: "api_key", key: "saved" }));
  await expect(auth.remove("test", "oauth")).rejects.toThrow("该登录方式已被替换");
  expect(await credentials.read("test")).toBeDefined();
  await auth.remove("test", "api_key");
  expect(await credentials.read("test")).toBeUndefined();
});

test("successful desktop login survives storage reopen and immediately makes authenticated models available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eta-login-"));
  const layer = CredentialService.layer.pipe(Layer.provide(AppPathsService.layer(directory)));
  const runtime = ManagedRuntime.make(layer);
  try {
    const service = await runtime.runPromise(CredentialService);
    const { auth } = setup(undefined, service.store);
    const flow = auth.start("test", "oauth");
    auth.answer(flow.id, flow.prompt!.id, "callback");
    expect((await completed(auth, flow.id)).status).toBe("completed");
    await runtime.dispose();
    const reopened = ManagedRuntime.make(layer);
    try {
      const saved = await reopened.runPromise(CredentialService);
      const { models, auth: restored } = setup(undefined, saved.store);
      expect(await saved.store.read("test")).toEqual(oauthCredential);
      expect(await models.getAvailable("test")).not.toHaveLength(0);
      await restored.remove("test", "oauth");
      expect(await models.getAvailable("test")).toHaveLength(0);
    } finally {
      await reopened.dispose();
    }
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed automatic browser launch leaves a usable manual link and can still finish", async () => {
  const { auth, open } = setup(async (interaction) => {
    interaction.notify({ type: "auth_url", url: "https://example.com/authorize" });
    await interaction.prompt({ type: "manual_code", message: "Code" });
    return oauthCredential;
  });
  open.mockRejectedValueOnce(new Error("Browser unavailable"));
  const flow = auth.start("test", "oauth");
  await vi.waitFor(() => expect(auth.read(flow.id).message).toContain("点击下方按钮"));
  expect(auth.read(flow.id).links[0]?.url).toBe("https://example.com/authorize");
  auth.answer(flow.id, flow.prompt!.id, "code");
  expect((await completed(auth, flow.id)).status).toBe("completed");
});

test("provider-supplied executable URLs never reach the browser launcher", async () => {
  const { auth, open } = setup(async (interaction) => {
    interaction.notify({ type: "auth_url", url: "file:///etc/passwd" });
    return oauthCredential;
  });
  const flow = auth.start("test", "oauth");
  expect((await completed(auth, flow.id)).status).toBe("failed");
  expect(open).not.toHaveBeenCalled();
});
