import { z } from "zod";
import {
  AdmissionSchema,
  ConnectionSchema,
  ErrorSchema,
  LibrarySchema,
  OpenThreadSchema,
  OperationSchema,
  ProjectSchema,
  SnapshotResponseSchema,
  ThreadSchema,
} from "./contracts.ts";
import type { Configuration, Connection } from "./contracts.ts";
import { delay, readEvents } from "./stream.ts";

export class BotError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function normalizeConnection(input: Connection): Connection {
  const parsed = ConnectionSchema.parse(input);
  let url: URL;
  try {
    url = new URL(parsed.url.trim());
  } catch {
    throw new Error("请输入有效的 Bot HTTP 或 HTTPS 地址");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入有效的 Bot HTTP 或 HTTPS 地址");
  if (!parsed.token.trim()) throw new Error("请输入 Bot 访问令牌");
  return { url: url.href.replace(/\/+$/, ""), token: parsed.token.trim() };
}

export class BotClient {
  readonly connection: Connection;
  constructor(
    connection: Connection,
    private readonly fetcher: typeof fetch,
    private readonly timeoutMs = 15000,
  ) {
    this.connection = normalizeConnection(connection);
  }

  private async response(
    path: string,
    body: object | undefined,
    signal: AbortSignal,
    streaming = false,
  ) {
    try {
      const response = await this.fetcher(this.connection.url + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal,
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          "content-type": "application/json",
          accept: streaming ? "text/event-stream" : "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        if (response.status === 401) {
          void response.body?.cancel().catch(() => {});
          throw new BotError("Bot 令牌无效，请修改连接设置", "Unauthorized", 401);
        }
        const error = ErrorSchema.safeParse(await response.json().catch(() => null));
        throw new BotError(
          error.success ? error.data.error.message : `Bot 请求失败 (${response.status})`,
          error.success ? error.data.error.code : "HttpError",
          response.status,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof BotError || signal.aborted) throw error;
      throw new BotError("无法连接 Bot，请检查地址和网络", "NetworkError");
    }
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: object,
    signal?: AbortSignal,
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.response(path, body, controller.signal);
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success)
        throw new BotError("Bot 返回的数据格式不兼容，请检查 Bot 版本", "InvalidResponse");
      return parsed.data;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted)
        throw new BotError("请求超时，接收状态尚未确认", "Timeout");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  library(signal?: AbortSignal) {
    return this.request("/v1/library", LibrarySchema, undefined, signal);
  }
  project(name: string, requestId: string) {
    return this.request("/v1/projects", ProjectSchema, { name, requestId });
  }
  private route(id: string) {
    return `/v1/threads/${encodeURIComponent(id)}`;
  }
  open(id: string, signal?: AbortSignal) {
    return this.request(this.route(id), OpenThreadSchema, undefined, signal);
  }
  create(workspaceId: string, requestId: string, configuration: Configuration) {
    return this.request("/v1/threads", OpenThreadSchema, { workspaceId, requestId, configuration });
  }
  send(id: string, prompt: string, requestId: string) {
    return this.request(this.route(id) + "/messages", AdmissionSchema, { prompt, requestId });
  }
  operation(id: string, operationId: string) {
    return this.request(
      this.route(id) + `/operations/${encodeURIComponent(operationId)}`,
      OperationSchema,
    );
  }
  stop(id: string) {
    return this.request(this.route(id) + "/stop", z.object({ stopped: z.boolean() }), {});
  }
  resume(id: string) {
    return this.request(this.route(id) + "/resume", z.object({ resumed: z.boolean() }), {});
  }
  configure(id: string, configuration: Configuration) {
    const { sandboxMode: _mode, ...model } = configuration;
    return this.request(this.route(id) + "/configure", OpenThreadSchema, model);
  }
  sandbox(id: string, mode: Configuration["sandboxMode"]) {
    return this.request(this.route(id) + "/sandbox", OpenThreadSchema, { mode });
  }
  approve(id: string, requestId: string, approved: boolean, reuse?: "call" | "run") {
    return this.request(
      this.route(id) + `/approvals/${encodeURIComponent(requestId)}`,
      OpenThreadSchema,
      { approved, ...(reuse ? { reuse } : {}) },
    );
  }
  rename(id: string, title: string) {
    return this.request(this.route(id) + "/metadata", ThreadSchema, { action: "rename", title });
  }
  archive(id: string, archived: boolean) {
    return this.request(this.route(id) + "/metadata", ThreadSchema, {
      action: "archive",
      archived,
    });
  }

  /** The server sends authoritative snapshots; reconnect does not replay missed events. */
  async watch(
    id: string,
    signal: AbortSignal,
    snapshot: (value: z.infer<typeof SnapshotResponseSchema>) => void,
    status: (error?: string, fatal?: boolean) => void,
  ) {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const response = await this.response(this.route(id) + "/events", undefined, signal, true);
        if (!response.body) throw new Error("Bot 未提供实时消息流");
        await readEvents(
          response.body,
          ({ event, data }) => {
            if (signal.aborted) return;
            if (event === "snapshot") {
              const parsed = SnapshotResponseSchema.safeParse(JSON.parse(data));
              if (!parsed.success) throw new BotError("Bot 实时数据格式不兼容", "InvalidResponse");
              attempt = 0;
              snapshot(parsed.data);
              status();
            }
            if (event === "error") {
              const parsed = z.object({ message: z.string() }).parse(JSON.parse(data));
              throw new Error(parsed.message);
            }
          },
          signal,
        );
        if (!signal.aborted) throw new Error("实时连接中断，正在重连");
      } catch (error) {
        if (signal.aborted) return;
        const fatal =
          error instanceof BotError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.status === 404 ||
            error.code === "InvalidResponse");
        status(error instanceof Error ? error.message : "实时连接中断", fatal);
        if (fatal) return;
      }
      await delay(Math.min(1000 * 2 ** attempt++, 30000), signal);
    }
  }
}
