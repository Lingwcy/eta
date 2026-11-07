import { open } from "node:fs/promises";
import { Schema } from "effect";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIP } from "node:net";
import { createProvider, type Model, type ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const MAX_RESPONSE = 1024 * 1024;
const TIMEOUT = 5000;
const MAX_CONFIG = 64 * 1024;
const Config = Schema.Struct({
  version: Schema.Literal(1),
  baseUrl: Schema.String,
  apiKey: Schema.String,
});
const Hello = Schema.Struct({ name: Schema.Literal("magpie"), version: Schema.String });
const Entry = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  magpie_label: Schema.optionalKey(Schema.String),
  context_window: Schema.optionalKey(Schema.Number),
  context_length: Schema.optionalKey(Schema.Number),
  max_input_tokens: Schema.optionalKey(Schema.Number),
  max_output_tokens: Schema.optionalKey(Schema.Number),
  reasoning: Schema.optionalKey(Schema.Boolean),
  reasoning_levels: Schema.optionalKey(Schema.Array(Schema.String)),
  supported_reasoning_levels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ effort: Schema.String })),
  ),
  modalities: Schema.optionalKey(
    Schema.Struct({ input: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
});
const Catalog = Schema.Struct({ data: Schema.Array(Entry) });

function origin(value: unknown) {
  if (typeof value !== "string") throw new Error("Invalid Magpie configuration");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Magpie configuration");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid Magpie configuration");
  return url.origin;
}

async function json(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  apiKey?: string,
): Promise<unknown> {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
    redirect: "error",
    headers: apiKey === undefined ? undefined : { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Magpie request failed");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new Error("Magpie response too large");
      bytes.set(value, size - value.byteLength);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch {
    throw new Error("Invalid Magpie response");
  }
}

function positive(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid Magpie catalog");
  return value;
}

/** Load the optional local gateway without writing its key to Eta credentials. */
export async function loadMagpieProvider(options: { path?: string; fetch?: typeof fetch } = {}) {
  // Agent plugins expand ~ and $VAR, but cannot choose a fallback for an unset variable.
  // Their stable home path takes precedence; keep older XDG configurations readable.
  const path = options.path ?? join(homedir(), ".config", "eta", "magpie.json");
  let raw: string;
  try {
    const file = await open(path, "r");
    try {
      const bytes = Buffer.alloc(MAX_CONFIG + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CONFIG) throw new Error("Invalid Magpie configuration");
      raw = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const legacy = process.env.XDG_CONFIG_HOME
        ? join(process.env.XDG_CONFIG_HOME, "eta", "magpie.json")
        : undefined;
      if (options.path === undefined && legacy && legacy !== path)
        return loadMagpieProvider({ ...options, path: legacy });
      return undefined;
    }
    throw new Error("Invalid Magpie configuration");
  }
  let config: typeof Config.Type;
  try {
    const value: unknown = JSON.parse(raw);
    // Magpie restores only its keys on disconnect, leaving an empty/unrelated object.
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !["version", "baseUrl", "apiKey"].some((key) => Object.hasOwn(value, key))
    )
      return undefined;
    config = Schema.decodeUnknownSync(Config)(value);
  } catch {
    throw new Error("Invalid Magpie configuration");
  }
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(config.apiKey))
    throw new Error("Invalid Magpie configuration");
  const base = origin(config.baseUrl);
  const apiKey = config.apiKey;
  const fetcher = options.fetch ?? fetch;
  const streams = openAICompletionsApi();
  const headers = <T extends { sessionId?: string; headers?: Record<string, string | null> }>(
    opts: T | undefined,
  ) =>
    opts?.sessionId
      ? { ...opts, headers: { ...opts.headers, "X-Magpie-Session": opts.sessionId } }
      : opts;
  const api: ProviderStreams = {
    stream: (model, context, opts) => streams.stream(model, context, headers(opts)),
    streamSimple: (model, context, opts) => streams.streamSimple(model, context, headers(opts)),
  };
  return createProvider({
    id: "magpie",
    name: "Magpie",
    baseUrl: base + "/v1",
    models: [],
    api,
    auth: {
      apiKey: {
        name: "Magpie",
        resolve: async () => ({ auth: { apiKey }, source: "Magpie configuration" }),
      },
    },
    fetchModels: async ({ signal }) => {
      let body: typeof Catalog.Type;
      try {
        Schema.decodeUnknownSync(Hello)(await json(fetcher, base + "/api/hello", signal));
      } catch {
        throw new Error("Invalid Magpie hello");
      }
      try {
        body = Schema.decodeUnknownSync(Catalog)(
          await json(fetcher, base + "/v1/models", signal, apiKey),
        );
      } catch {
        throw new Error("Invalid Magpie catalog");
      }
      const seen = new Set<string>();
      return body.data.map((entry): Model<"openai-completions"> => {
        if (!entry.id || seen.has(entry.id)) throw new Error("Invalid Magpie catalog");
        seen.add(entry.id);
        for (const value of [
          entry.context_window,
          entry.context_length,
          entry.max_input_tokens,
          entry.max_output_tokens,
        ])
          positive(value, 1);
        // Conservative client budgets when the gateway omits limits, not model capability claims.
        const contextWindow = positive(
          entry.context_window,
          positive(entry.context_length, positive(entry.max_input_tokens, 8192)),
        );
        const modalities = entry.modalities?.input ?? [];
        const levels =
          entry.reasoning_levels ??
          entry.supported_reasoning_levels?.map((level) => level.effort) ??
          [];
        const thinkingLevelMap = Object.fromEntries(
          ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
            level,
            levels.includes(level) ? level : null,
          ]),
        );
        return {
          id: entry.id,
          name:
            typeof entry.magpie_label === "string" && entry.magpie_label
              ? entry.magpie_label
              : typeof entry.display_name === "string" && entry.display_name
                ? entry.display_name
                : entry.id,
          provider: "magpie",
          api: "openai-completions",
          baseUrl: base + "/v1",
          input: modalities.includes("image") ? ["text", "image"] : ["text"],
          reasoning: entry.reasoning === true && levels.length > 0,
          thinkingLevelMap,
          contextWindow,
          maxTokens: Math.min(positive(entry.max_output_tokens, 2048), contextWindow),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      });
    },
  });
}
