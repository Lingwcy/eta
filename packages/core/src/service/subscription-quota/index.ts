import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { QuotaConnection, SubscriptionQuota } from "../../shared/subscription-quota.ts";
import { codexWindows, copilotWindows } from "./adapters.ts";

type Options = {
  models: Models;
  credentials: CredentialStore;
  connections: () => Promise<readonly QuotaConnection[]>;
  isCurrent: (providerId: string, connectionId: string) => boolean;
  fetch?: typeof fetch;
  now?: () => number;
};
type Failure = NonNullable<SubscriptionQuota["error"]>;
class QueryFailure extends Error {
  constructor(
    readonly kind: Failure,
    readonly retryAt?: number,
  ) {
    super(kind);
  }
}
const supported = new Set(["openai-codex", "github-copilot"]);
const MAX_BODY = 1024 * 1024;
const TTL = 60_000;

async function json(response: Response): Promise<unknown> {
  if (!response.body) throw new QueryFailure("unavailable");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_BODY);
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (size + part.value.byteLength > MAX_BODY) {
        await reader.cancel();
        throw new QueryFailure("unavailable");
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
}

export function createSubscriptionQuotaService(options: Options) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, SubscriptionQuota>();
  const flights = new Map<
    string,
    {
      connectionId: string;
      promise: Promise<SubscriptionQuota | null>;
      controller: AbortController;
    }
  >();
  const cooldowns = new Map<string, { connectionId: string; until: number }>();
  let closed = false;
  let active = 0;
  const waiting: Array<() => void> = [];
  async function acquire(signal: AbortSignal) {
    while (active >= 3) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason);
        };
        if (signal.aborted) return abort();
        waiting.push(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    signal.throwIfAborted();
    active++;
    return () => {
      active--;
      waiting.shift()?.();
    };
  }
  async function eligible(providerId: string, connectionId: string) {
    if (closed || !supported.has(providerId)) return false;
    const provider = options.models.getProviders().find((entry) => entry.id === providerId);
    if (!provider?.auth.oauth) return false;
    const connections = await options.connections();
    if (
      closed ||
      !connections.some((c) => c.providerId === providerId && c.connectionId === connectionId)
    )
      return false;
    const credential = await options.credentials.read(providerId);
    if (credential?.type !== "oauth" || closed) return false;
    if (
      providerId === "github-copilot" &&
      typeof credential.enterpriseUrl === "string" &&
      credential.enterpriseUrl
    )
      return false;
    const current = await options.connections();
    return (
      !closed &&
      options.isCurrent(providerId, connectionId) &&
      current.some((c) => c.providerId === providerId && c.connectionId === connectionId)
    );
  }
  async function list(): Promise<QuotaConnection[]> {
    const connections = await options.connections();
    const results = await Promise.all(
      connections.map(async (c) => ((await eligible(c.providerId, c.connectionId)) ? c : null)),
    );
    return closed
      ? []
      : results.filter(
          (c): c is QuotaConnection =>
            c !== null && options.isCurrent(c.providerId, c.connectionId),
        );
  }
  async function query(
    providerId: string,
    connectionId: string,
    refresh = false,
  ): Promise<SubscriptionQuota | null> {
    if (!(await eligible(providerId, connectionId)) || !options.isCurrent(providerId, connectionId))
      return null;
    const oldFlight = flights.get(providerId);
    if (oldFlight?.connectionId === connectionId) {
      const result = await oldFlight.promise;
      return result &&
        (await eligible(providerId, connectionId)) &&
        options.isCurrent(providerId, connectionId)
        ? structuredClone(result)
        : null;
    }
    if (oldFlight) oldFlight.controller.abort();
    const cached = cache.get(providerId);
    const previous = cached?.connectionId === connectionId ? cached : undefined;
    const cooldown = cooldowns.get(providerId);
    if (
      (previous?.retryAt && previous.retryAt > now()) ||
      (previous && cooldown?.connectionId === connectionId && cooldown.until > now()) ||
      (!refresh &&
        previous?.status === "ready" &&
        previous.readAt !== undefined &&
        now() - previous.readAt < TTL)
    )
      return (await eligible(providerId, connectionId)) &&
        options.isCurrent(providerId, connectionId)
        ? structuredClone(previous)
        : null;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    const owner = {
      connectionId,
      controller,
      promise: Promise.resolve(null) as Promise<SubscriptionQuota | null>,
    };
    flights.set(providerId, owner);
    const minimumRetryAt = now() + 5000;
    cooldowns.set(providerId, { connectionId, until: minimumRetryAt });
    owner.promise = (async () => {
      let result: SubscriptionQuota;
      try {
        const credential = await options.credentials.read(providerId, { signal });
        if (
          credential?.type !== "oauth" ||
          !(await eligible(providerId, connectionId)) ||
          !options.isCurrent(providerId, connectionId)
        )
          return null;
        let url: string;
        let headers: Record<string, string>;
        if (providerId === "openai-codex") {
          const auth = await options.models.getAuth(providerId, { signal });
          if (
            !(await eligible(providerId, connectionId)) ||
            !options.isCurrent(providerId, connectionId)
          )
            return null;
          const latest = await options.credentials.read(providerId, { signal });
          if (
            latest?.type !== "oauth" ||
            typeof latest.accountId !== "string" ||
            !latest.accountId ||
            !auth?.auth.apiKey
          )
            throw new QueryFailure("unauthorized");
          url = "https://chatgpt.com/backend-api/wham/usage";
          headers = {
            Authorization: `Bearer ${auth.auth.apiKey}`,
            "ChatGPT-Account-Id": latest.accountId,
            Accept: "application/json",
          };
        } else {
          if (typeof credential.enterpriseUrl === "string" && credential.enterpriseUrl)
            throw new QueryFailure("unavailable");
          if (!credential.refresh) throw new QueryFailure("unauthorized");
          url = "https://api.github.com/copilot_internal/user";
          headers = {
            Authorization: `token ${credential.refresh}`,
            Accept: "application/json",
            "User-Agent": "Eta",
            "Editor-Version": "vscode/1.99.0",
            "Editor-Plugin-Version": "copilot-chat/0.26.7",
            "Copilot-Integration-Id": "vscode-chat",
          };
        }
        if (
          !(await eligible(providerId, connectionId)) ||
          !options.isCurrent(providerId, connectionId) ||
          signal.aborted
        )
          return null;
        const release = await acquire(signal);
        try {
          if (
            !(await eligible(providerId, connectionId)) ||
            !options.isCurrent(providerId, connectionId) ||
            signal.aborted
          )
            return null;
          const response = await fetcher(url, { headers, signal, redirect: "manual" });
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            if (response.status === 401 || response.status === 403)
              throw new QueryFailure("unauthorized");
            if (response.status === 429) {
              const header = response.headers.get("retry-after");
              const seconds = header === null ? NaN : Number(header);
              const date = header === null ? NaN : Date.parse(header);
              const retryAt =
                Number.isFinite(seconds) && seconds >= 0
                  ? now() + seconds * 1000
                  : Number.isFinite(date)
                    ? date
                    : now() + TTL;
              // Finite seconds can still overflow or exceed Date range after conversion.
              throw new QueryFailure(
                "rate-limit",
                Number.isFinite(retryAt) && retryAt >= 0 && retryAt <= 8.64e15
                  ? retryAt
                  : now() + TTL,
              );
            }
            throw new QueryFailure("unavailable");
          }
          const body = await json(response);
          const windows =
            providerId === "openai-codex" ? codexWindows(body, now()) : copilotWindows(body);
          if (!windows.length) throw new QueryFailure("unavailable");
          result = { providerId, connectionId, status: "ready", windows, readAt: now() };
        } finally {
          release();
        }
      } catch (error) {
        const failure = error instanceof QueryFailure ? error : new QueryFailure("unavailable");
        result = {
          providerId,
          connectionId,
          status: "error",
          windows: previous?.windows ?? [],
          ...(previous?.readAt === undefined ? {} : { readAt: previous.readAt, stale: true }),
          error: failure.kind,
          ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
        };
      }
      if (
        (signal.aborted && controller.signal.aborted) ||
        !(await eligible(providerId, connectionId)) ||
        flights.get(providerId) !== owner ||
        !options.isCurrent(providerId, connectionId)
      )
        return null;
      result = { ...result, retryAt: Math.max(result.retryAt ?? 0, minimumRetryAt) };
      cache.set(providerId, structuredClone(result));
      return structuredClone(result);
    })().finally(() => {
      if (flights.get(providerId) === owner) flights.delete(providerId);
    });
    return owner.promise;
  }
  function invalidate() {
    for (const [providerId, flight] of flights) {
      if (!options.isCurrent(providerId, flight.connectionId)) {
        flight.controller.abort();
        flights.delete(providerId);
      }
    }
    for (const [providerId, value] of cache)
      if (!options.isCurrent(providerId, value.connectionId)) cache.delete(providerId);
    for (const [providerId, value] of cooldowns)
      if (!options.isCurrent(providerId, value.connectionId)) cooldowns.delete(providerId);
  }
  function close() {
    closed = true;
    for (const flight of flights.values()) flight.controller.abort();
    flights.clear();
    cache.clear();
    cooldowns.clear();
  }
  return { list, query, invalidate, close };
}
