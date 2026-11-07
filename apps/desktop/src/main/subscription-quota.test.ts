import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Layer, ManagedRuntime } from "effect";
import { expect, test, vi } from "vite-plus/test";
import { AppPathsService } from "@eta/core/platform/app-paths";
import { CredentialService } from "@eta/core/service/credentials/index";
import { createSubscriptionQuotaService } from "@eta/core/service/subscription-quota/index";
import { DesktopAuthentication } from "./authentication/index.ts";
import { dispatchCommand } from "./ipc.ts";
import type { DesktopApplication } from "./bootstrap.ts";

const providerId = "openai-codex";
const credential = {
  type: "oauth" as const,
  access: "private-access-token",
  refresh: "private-refresh-token",
  accountId: "test-account",
  expires: Date.now() + 3_600_000,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-subscription-quota-"));
  const runtime = ManagedRuntime.make(
    CredentialService.layer.pipe(Layer.provide(AppPathsService.layer(directory))),
  );
  const credentials = await runtime.runPromise(CredentialService);
  const models = createModels({ credentials: credentials.store });
  const loginModels = createModels({ credentials: credentials.loginStore });
  const base = fauxProvider({ provider: providerId }).provider;
  const provider = {
    ...base,
    auth: {
      oauth: {
        name: "Test subscription",
        login: async () => credential,
        refresh: async () => credential,
        toAuth: async (value: typeof credential) => ({ apiKey: value.access }),
      },
    },
  };
  models.setProvider(provider);
  loginModels.setProvider(provider);
  const authentication = new DesktopAuthentication(
    models,
    credentials.store,
    async () => {},
    "device",
    loginModels,
  );
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: 28, limit_window_seconds: 18_000, reset_at: 2_000_000_000 },
        secondary_window: {
          used_percent: 54,
          limit_window_seconds: 604_800,
          reset_at: 2_000_100_000,
        },
      },
    }),
  );
  const quotas = createSubscriptionQuotaService({
    models,
    credentials: credentials.store,
    connections: () => runtime.runPromise(credentials.accountConnections),
    isCurrent: (providerId, connectionId) =>
      credentials.isAccountConnection(providerId, connectionId),
    fetch: fetcher,
  });
  const stopInvalidation = credentials.subscribe(quotas.invalidate);
  // Run the actual IPC decoder against the real reader, not a callback echo.
  const application = { subscriptionQuota: quotas.query } as unknown as DesktopApplication;
  async function login() {
    const state = authentication.start(providerId, "oauth");
    await vi.waitFor(() => expect(authentication.read(state.id).status).toBe("completed"));
    return (await quotas.list())[0]!;
  }
  return {
    credentials,
    runtime,
    authentication,
    fetcher,
    quotas,
    application,
    login,
    close: async () => {
      stopInvalidation();
      quotas.close();
      await authentication.close();
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("explicit account login enables a sanitized IPC quota reading; logout removes it", async () => {
  const f = await fixture();
  const changes = vi.fn();
  const off = f.credentials.subscribe(changes);
  try {
    await f.runtime.runPromise(f.credentials.import({ [providerId]: credential }));
    expect(await f.quotas.list()).toEqual([]);
    expect(
      await dispatchCommand(f.application, {
        type: "subscription-quota",
        providerId,
        connectionId: "imported",
      }),
    ).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
    const connection = await f.login();
    expect(changes).toHaveBeenCalledTimes(1);
    const command = { type: "subscription-quota", ...connection };
    const result = await dispatchCommand(f.application, command);
    expect(result).toMatchObject({
      ...connection,
      status: "ready",
      windows: [
        { usedPercent: 28, windowMinutes: 300 },
        { usedPercent: 54, windowMinutes: 10_080 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain(credential.accountId);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await dispatchCommand(f.application, command);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await f.authentication.remove(providerId, "oauth");
    expect(changes).toHaveBeenCalledTimes(2);
    expect(await f.quotas.list()).toEqual([]);
    expect(await dispatchCommand(f.application, command)).toBeNull();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  } finally {
    off();
    await f.close();
  }
});

test("relogin and logout cannot publish an old connection's pending quota", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const held = Promise.withResolvers<Response>();
  try {
    const old = await f.login();
    f.fetcher.mockImplementationOnce(async () => {
      entered.resolve();
      return held.promise;
    });
    const pending = dispatchCommand(f.application, { type: "subscription-quota", ...old });
    await entered.promise;
    const replacement = await f.login();
    expect(replacement.connectionId).not.toBe(old.connectionId);
    held.resolve(
      Response.json({
        rate_limit: { primary_window: { used_percent: 99, limit_window_seconds: 18_000 } },
      }),
    );
    expect(await pending).toBeNull();
    const current = await dispatchCommand(f.application, {
      type: "subscription-quota",
      ...replacement,
    });
    expect(current).toMatchObject({
      connectionId: replacement.connectionId,
      status: "ready",
      windows: [{ usedPercent: 28 }, { usedPercent: 54 }],
    });
    await f.authentication.remove(providerId, "oauth");
    expect(
      await dispatchCommand(f.application, {
        type: "subscription-quota",
        ...replacement,
        refresh: true,
      }),
    ).toBeNull();
  } finally {
    held.resolve(Response.json({}));
    await f.close();
  }
});

test("logout aborts the owned quota request through credential notifications", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<AbortSignal>();
  try {
    const connection = await f.login();
    f.fetcher.mockImplementationOnce(async (_url, init) => {
      const signal = init!.signal!;
      entered.resolve(signal);
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    });
    const pending = dispatchCommand(f.application, { type: "subscription-quota", ...connection });
    const signal = await entered.promise;
    await f.authentication.remove(providerId, "oauth");
    expect(signal.aborted).toBe(true);
    expect(await pending).toBeNull();
    expect(await f.quotas.list()).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each([
  { type: "subscription-quota", providerId: "", connectionId: "login" },
  { type: "subscription-quota", providerId, connectionId: "" },
  { type: "subscription-quota", providerId, connectionId: "login", refresh: "yes" },
  { type: "subscription-quota", providerId, connectionId: "login", url: "https://example.com" },
])("quota IPC rejects malformed input without starting a request: %j", async (command) => {
  const f = await fixture();
  try {
    await expect(dispatchCommand(f.application, command)).rejects.toMatchObject({
      code: "InvalidInput",
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
