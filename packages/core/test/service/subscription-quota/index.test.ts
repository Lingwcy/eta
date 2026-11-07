import { describe, expect, test, vi } from "vite-plus/test";
import { InMemoryCredentialStore, createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createSubscriptionQuotaService } from "../../../src/service/subscription-quota/index.ts";

const oauth = {
  type: "oauth" as const,
  access: "access",
  refresh: "github-token",
  expires: Date.now() + 60_000,
  accountId: "account",
};
function fixture() {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  for (const id of ["openai-codex", "github-copilot", "openai"]) {
    const provider = fauxProvider({ provider: id }).provider;
    models.setProvider({
      ...provider,
      auth: {
        oauth: {
          name: id,
          login: async () => oauth,
          refresh: async (v) => v,
          toAuth: async (v) => ({ apiKey: v.access }),
        },
      },
    });
  }
  let connections = [{ providerId: "openai-codex", connectionId: "a" }];
  let clock = 1_000_000;
  let readConnections = async () => connections;
  const fetcher = vi.fn<typeof fetch>();
  const service = createSubscriptionQuotaService({
    models,
    credentials,
    connections: () => readConnections(),
    isCurrent: (providerId, connectionId) =>
      connections.some((c) => c.providerId === providerId && c.connectionId === connectionId),
    fetch: fetcher,
    now: () => clock,
  });
  return {
    service,
    credentials,
    fetcher,
    setConnections: (value: typeof connections) => {
      connections = value;
    },
    setReader: (reader: () => Promise<typeof connections>) => {
      readConnections = reader;
    },
    advance: (n: number) => {
      clock += n;
    },
  };
}
const codex = {
  rate_limit: {
    primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 2000 },
    secondary_window: {
      used_percent: 100,
      limit_window_seconds: 604800,
      reset_after_seconds: 3600,
    },
  },
};
const response = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), init);

describe("subscription quota", () => {
  test("requires a supported pi-ai OAuth provider with an explicit connection", async () => {
    const f = fixture();
    f.setConnections([
      { providerId: "openai-codex", connectionId: "a" },
      { providerId: "openai", connectionId: "b" },
    ]);
    await f.credentials.modify("openai-codex", async () => oauth);
    await f.credentials.modify("openai", async () => oauth);
    expect(await f.service.list()).toEqual([{ providerId: "openai-codex", connectionId: "a" }]);
    expect(await f.service.query("openai", "b")).toBeNull();
    expect(await f.service.query("openai-codex", "wrong")).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  test("reads Codex windows with account auth, caches, and refreshes one provider", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher.mockResolvedValue(response(codex));
    const first = await f.service.query("openai-codex", "a");
    expect(first).toMatchObject({
      status: "ready",
      retryAt: 1005000,
      windows: [
        { id: "primary", usedPercent: 25, windowMinutes: 300, resetsAt: 2000000 },
        { id: "secondary", usedPercent: 100, windowMinutes: 10080, resetsAt: 4600000 },
      ],
    });
    expect(f.fetcher).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access",
          "ChatGPT-Account-Id": "account",
        }),
        redirect: "manual",
      }),
    );
    f.advance(1000);
    expect(await f.service.query("openai-codex", "a")).toEqual(first);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(4000);
    await f.service.query("openai-codex", "a", true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(61_000);
    await f.service.query("openai-codex", "a");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  test("Copilot uses original GitHub token, preserves numbers and unlimited", async () => {
    const f = fixture();
    f.setConnections([{ providerId: "github-copilot", connectionId: "c" }]);
    await f.credentials.modify("github-copilot", async () => oauth);
    f.fetcher.mockResolvedValue(
      response({
        quota_reset_date: "2030-01-01",
        quota_snapshots: {
          premium_interactions: { entitlement: "300", quota_remaining: "180" },
          chat: { unlimited: true },
        },
      }),
    );
    expect(await f.service.query("github-copilot", "c")).toMatchObject({
      status: "ready",
      windows: [
        { id: "chat", unlimited: true },
        { id: "premium_interactions", remaining: 180, total: 300 },
      ],
    });
    expect(f.fetcher).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "token github-token" }),
      }),
    );
  });
  test("rate limit retains a dated stale value and respects retry-after even for manual refresh", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher
      .mockResolvedValueOnce(response(codex))
      .mockResolvedValueOnce(response({}, { status: 429, headers: { "retry-after": "30" } }));
    await f.service.query("openai-codex", "a");
    f.advance(5000);
    const failed = await f.service.query("openai-codex", "a", true);
    expect(failed).toMatchObject({
      status: "error",
      error: "rate-limit",
      readAt: 1000000,
      stale: true,
      retryAt: 1035000,
      windows: [{ usedPercent: 25 }, { usedPercent: 100 }],
    });
    expect(await f.service.query("openai-codex", "a", true)).toEqual(failed);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  test.each([
    ["arithmetic overflow", "9".repeat(307)],
    ["Date range overflow", "9".repeat(16)],
  ])("out-of-range Retry-After cannot disable future quota reads: %s", async (_name, header) => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher
      .mockResolvedValueOnce(response({}, { status: 429, headers: { "retry-after": header } }))
      .mockResolvedValueOnce(response(codex));
    try {
      const limited = await f.service.query("openai-codex", "a");
      f.advance(60000);
      expect(await f.service.query("openai-codex", "a", true)).toMatchObject({ status: "ready" });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
      expect(limited).toMatchObject({ status: "error", error: "rate-limit", retryAt: 1060000 });
      expect(Number.isFinite(new Date(limited!.retryAt!).valueOf())).toBe(true);
      expect(JSON.parse(JSON.stringify(limited)).retryAt).toBe(limited!.retryAt);
    } finally {
      f.service.close();
    }
  });

  test.each([
    { name: "future", date: 1030000, expected: 1030000 },
    { name: "past", date: 900000, expected: 1005000 },
  ])("valid $name HTTP-date Retry-After keeps its cooldown", async ({ date, expected }) => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher
      .mockResolvedValueOnce(
        response({}, { status: 429, headers: { "retry-after": new Date(date).toUTCString() } }),
      )
      .mockResolvedValueOnce(response(codex));
    try {
      const limited = await f.service.query("openai-codex", "a");
      expect(limited).toMatchObject({ status: "error", error: "rate-limit", retryAt: expected });
      expect(await f.service.query("openai-codex", "a", true)).toEqual(limited);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      f.advance(expected - 1000000);
      expect(await f.service.query("openai-codex", "a", true)).toMatchObject({ status: "ready" });
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      f.service.close();
    }
  });

  test("old response cannot publish after replacement and cannot release replacement flight", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    let release!: (r: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetcher
      .mockImplementationOnce(async () => {
        entered();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValue(response(codex));
    const old = f.service.query("openai-codex", "a");
    try {
      await started;
      f.setConnections([{ providerId: "openai-codex", connectionId: "b" }]);
      const next = await f.service.query("openai-codex", "b");
      expect(next).toMatchObject({ connectionId: "b", status: "ready" });
      release(response(codex));
      expect(await old).toBeNull();
      expect(await f.service.query("openai-codex", "b")).toEqual(next);
      expect(f.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      release?.(response(codex));
      f.service.close();
    }
  });
  test("a delayed old connection snapshot cannot abort its replacement", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let current = [{ providerId: "openai-codex", connectionId: "a" }];
    let reads = 0;
    f.setReader(async () => {
      const snapshot = current;
      if (++reads === 2) {
        entered();
        await gate;
      }
      return snapshot;
    });
    f.fetcher.mockResolvedValue(response(codex));
    const old = f.service.query("openai-codex", "a");
    try {
      await started;
      current = [{ providerId: "openai-codex", connectionId: "b" }];
      f.setConnections(current);
      expect(await f.service.query("openai-codex", "b")).toMatchObject({
        status: "ready",
        connectionId: "b",
      });
      release();
      expect(await old).toBeNull();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    } finally {
      release();
      f.service.close();
    }
  });
  test("identity is rechecked after a delayed credential read", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    const read = f.credentials.read.bind(f.credentials);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(f.credentials, "read").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return read(...args);
    });
    const query = f.service.query("openai-codex", "a");
    try {
      await started;
      f.setConnections([{ providerId: "openai-codex", connectionId: "b" }]);
      release();
      expect(await query).toBeNull();
      expect(f.fetcher).not.toHaveBeenCalled();
    } finally {
      release();
      f.service.close();
    }
  });
  test("returned windows cannot mutate the cache and rapid refresh is coalesced", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher.mockResolvedValue(response(codex));
    const first = await f.service.query("openai-codex", "a");
    first!.windows[0]!.usedPercent = 99;
    expect((await f.service.query("openai-codex", "a", true))?.windows[0]?.usedPercent).toBe(25);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  test("401 does not delete credentials, generate a request, or leak response secrets", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher.mockResolvedValue(new Response("private response text", { status: 401 }));
    const result = await f.service.query("openai-codex", "a");
    expect(result).toMatchObject({ status: "error", error: "unauthorized", windows: [] });
    expect(JSON.stringify(result)).not.toContain("private response text");
    expect(await f.credentials.read("openai-codex")).toEqual(oauth);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect((f.fetcher.mock.calls[0]![1] as RequestInit).method).toBeUndefined();
  });
  test("enterprise Copilot is not exposed or queried", async () => {
    const f = fixture();
    f.setConnections([{ providerId: "github-copilot", connectionId: "ghe" }]);
    await f.credentials.modify("github-copilot", async () => ({
      ...oauth,
      enterpriseUrl: "example.com",
    }));
    expect(await f.service.list()).toEqual([]);
    expect(await f.service.query("github-copilot", "ghe")).toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  test("rejects reset timestamps outside the JavaScript Date range", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher.mockResolvedValue(
      response({
        rate_limit: {
          primary_window: { used_percent: 3, reset_at: 1e20 },
          secondary_window: { used_percent: 4, reset_after_seconds: 1e20 },
        },
      }),
    );
    const quota = await f.service.query("openai-codex", "a");
    expect(quota?.windows).toHaveLength(2);
    expect(quota?.windows.every((w) => w.resetsAt === undefined)).toBe(true);
    f.setConnections([{ providerId: "github-copilot", connectionId: "c" }]);
    await f.credentials.modify("github-copilot", async () => oauth);
    f.fetcher.mockResolvedValue(
      response({ quota_snapshots: { chat: { unlimited: true, quota_reset_at: 1e20 } } }),
    );
    expect((await f.service.query("github-copilot", "c"))?.windows[0]?.resetsAt).toBeUndefined();
  });
  test("invalidation aborts active fetch and discards its result", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let signal: AbortSignal | null | undefined;
    f.fetcher.mockImplementationOnce(async (_url, init) => {
      signal = init?.signal;
      entered();
      return await new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    });
    const pending = f.service.query("openai-codex", "a");
    try {
      await started;
      f.setConnections([]);
      f.service.invalidate();
      expect(signal?.aborted).toBe(true);
      expect(await pending).toBeNull();
    } finally {
      f.service.close();
    }
  });
  test("unrelated identity invalidation preserves an active request", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    let release!: (r: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetcher.mockImplementationOnce(async () => {
      entered();
      return await new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const pending = f.service.query("openai-codex", "a");
    try {
      await started;
      f.setConnections([
        { providerId: "openai-codex", connectionId: "a" },
        { providerId: "github-copilot", connectionId: "new" },
      ]);
      f.service.invalidate();
      release(response(codex));
      expect(await pending).toMatchObject({ status: "ready", connectionId: "a" });
    } finally {
      release?.(response(codex));
      f.service.close();
    }
  });
  test("malformed secondary window fails the whole reading, retaining last snapshot", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher.mockResolvedValueOnce(response(codex)).mockResolvedValueOnce(
      response({
        rate_limit: {
          primary_window: { used_percent: 7 },
          secondary_window: { used_percent: "bad" },
        },
      }),
    );
    await f.service.query("openai-codex", "a");
    f.advance(5000);
    expect(await f.service.query("openai-codex", "a", true)).toMatchObject({
      status: "error",
      stale: true,
      windows: [{ usedPercent: 25 }, { usedPercent: 100 }],
    });
  });
  test("malformed and oversized responses are not shown as quota", async () => {
    const f = fixture();
    await f.credentials.modify("openai-codex", async () => oauth);
    f.fetcher
      .mockResolvedValueOnce(response({ rate_limit: { primary_window: { used_percent: -1 } } }))
      .mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
    expect(await f.service.query("openai-codex", "a")).toMatchObject({
      status: "error",
      windows: [],
    });
    f.advance(5000);
    expect(await f.service.query("openai-codex", "a", true)).toMatchObject({
      status: "error",
      windows: [],
    });
  });
});
