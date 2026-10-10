import type { CreateThreadConfiguration } from "@eta/core/agent/protocol";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { Schema } from "effect";
import type { BotLibrary } from "@eta/core/shared/bot";
import type { SessionResponse, SnapshotResponse } from "@eta/core/agent/protocol";
import type { ProjectMetadata } from "@eta/core/shared/projects";
import type { ThreadMetadata } from "@eta/core/shared/threads";
import type { BotConnection, BotState } from "../shared/bot.ts";
import { isCloudId } from "../shared/bot.ts";
import { BotConnectionSchema } from "./bot-schema.ts";
import type { LocalDesktopApplication } from "./bootstrap.ts";

/** Remote identities never enter the local catalog, even while a Bot is unavailable. */
export class DesktopBot {
  private connection?: BotConnection;
  private state: BotState = { status: "disconnected" };
  private prefix = "";
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Set<AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private generation = 0;

  constructor(private readonly dataRoot: string) {}

  async initialize() {
    try {
      const raw = await readFile(join(this.dataRoot, "bot-connection.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return;
          throw error;
        },
      );
      if (!raw) return;
      this.use(Schema.decodeUnknownSync(BotConnectionSchema)(JSON.parse(raw)));
      const cache = await readFile(join(this.dataRoot, "bot-library.json"), "utf8")
        .then((value) => JSON.parse(value) as { url: string; library: BotLibrary })
        .catch(() => undefined);
      if (cache?.url === this.connection?.url)
        this.state = { ...this.state, library: cache?.library };
      await this.refresh();
    } catch (error) {
      this.state = {
        ...this.state,
        status: "error",
        message: error instanceof Error ? error.message : "无法读取 Bot 连接",
      };
    }
  }

  private use(connection: BotConnection) {
    if (!URL.canParse(connection.url)) throw new Error("请输入有效的 Bot HTTP 或 HTTPS 地址");
    const url = new URL(connection.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("请输入有效的 Bot HTTP 或 HTTPS 地址");
    if (!connection.token.trim()) throw new Error("请输入 Bot 访问令牌");
    this.connection = { url: url.href.replace(/\/+$/, ""), token: connection.token.trim() };
    this.prefix = `bot:${createHash("sha256").update(this.connection.url).digest("hex").slice(0, 16)}:`;
    this.state = { status: "error", url: this.connection.url, message: "尚未连接" };
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }
  private cancelStreams() {
    for (const controller of this.streams) controller.abort();
    this.streams.clear();
  }

  async connect(connection: BotConnection) {
    const candidate = new DesktopBot(this.dataRoot);
    candidate.use(connection);
    const library = candidate.mapLibrary(await candidate.request<BotLibrary>("/v1/library"));
    ++this.generation;
    if (this.connection?.url !== candidate.connection!.url) this.cancelStreams();
    this.use(candidate.connection!);
    this.state = {
      status: "connected",
      url: this.connection!.url,
      library,
    };
    await writeFile(join(this.dataRoot, "bot-connection.json"), JSON.stringify(this.connection), {
      mode: 0o600,
    });
    await this.cache();
    this.publish();
    return this.state;
  }

  async disconnect() {
    ++this.generation;
    this.cancelStreams();
    this.connection = undefined;
    this.state = { status: "disconnected" };
    await rm(join(this.dataRoot, "bot-connection.json"), { force: true });
    await rm(join(this.dataRoot, "bot-library.json"), { force: true });
    this.publish();
    return this.state;
  }

  status() {
    return this.state;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, 5000);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  async refresh(force = false) {
    if (this.refreshing) {
      await this.refreshing;
      if (!force) return;
    }
    if (!this.connection) return;
    const generation = this.generation;
    this.refreshing = (async () => {
      try {
        const library = this.mapLibrary(await this.request<BotLibrary>("/v1/library"));
        if (generation !== this.generation) return;
        const next: BotState = { status: "connected", url: this.connection!.url, library };
        const changed = JSON.stringify(next) !== JSON.stringify(this.state);
        this.state = next;
        if (changed) {
          await this.cache();
          this.publish();
        }
      } catch (error) {
        if (generation !== this.generation) return;
        const next: BotState = {
          ...this.state,
          status: "error",
          message: error instanceof Error ? error.message : "Bot 连接失败",
        };
        const changed = JSON.stringify(next) !== JSON.stringify(this.state);
        this.state = next;
        if (changed) this.publish();
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private cache() {
    return writeFile(
      join(this.dataRoot, "bot-library.json"),
      JSON.stringify({ url: this.connection?.url, library: this.state.library }),
      { mode: 0o600 },
    );
  }
  private raw(id: string) {
    if (!this.connection || !id.startsWith(this.prefix))
      throw new Error("此云端项目或会话所属的 Bot 未连接，请在设置中连接原来的 Bot");
    return id.slice(this.prefix.length);
  }
  private thread(value: ThreadMetadata): ThreadMetadata {
    return {
      ...value,
      id: this.prefix + value.id,
      workspaceId: this.prefix + value.workspaceId,
      ...(value.projectId ? { projectId: this.prefix + value.projectId } : {}),
      sessionRef: {
        ...value.sessionRef,
        metadata: { ...value.sessionRef.metadata, id: this.prefix + value.sessionRef.metadata.id },
      },
    };
  }
  private mapLibrary(library: BotLibrary): BotLibrary {
    return {
      ...library,
      projects: library.projects.map((project) => ({ ...project, id: this.prefix + project.id })),
      workspaces: library.workspaces.map((workspace) => ({
        ...workspace,
        id: this.prefix + workspace.id,
        projectId: this.prefix + workspace.projectId,
      })),
      threads: library.threads.map((thread) => this.thread(thread)),
    };
  }
  private session(value: SessionResponse): SessionResponse {
    return { ...value, id: this.prefix + value.id };
  }

  private async response(path: string, body?: object, signal?: AbortSignal) {
    if (!this.connection) throw new Error("请先连接 Bot");
    const response = await fetch(this.connection.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        response.status === 401
          ? "Bot 令牌无效"
          : (error?.error?.message ?? `Bot 请求失败 (${response.status})`),
      );
    }
    return response;
  }
  async request<T>(path: string, body?: object): Promise<T> {
    return (await this.response(path, body)).json() as Promise<T>;
  }
  private route(id: string) {
    return `/v1/threads/${encodeURIComponent(this.raw(id))}`;
  }
  async createProject(name: string, requestId: string) {
    const project = await this.request<ProjectMetadata>("/v1/projects", { name, requestId });
    await this.refresh(true);
    return { ...project, id: this.prefix + project.id };
  }
  async open(id: string) {
    return this.session(await this.request<SessionResponse>(this.route(id)));
  }
  async create(workspaceId: string, requestId: string, configuration?: CreateThreadConfiguration) {
    if (configuration?.sandboxMode) this.requireSandbox();
    const result = this.session(
      await this.request<SessionResponse>("/v1/threads", {
        workspaceId: this.raw(workspaceId),
        requestId,
        ...(configuration ? { configuration } : {}),
      }),
    );
    await this.refresh(true);
    return result;
  }
  async configure(id: string, provider: string, modelId: string, thinkingLevel: string) {
    return this.session(
      await this.request<SessionResponse>(this.route(id) + "/configure", {
        provider,
        modelId,
        thinkingLevel,
      }),
    );
  }
  async configureSandbox(id: string, mode: import("@eta/core/shared/sandbox").SandboxMode) {
    this.requireSandbox();
    return this.session(await this.request<SessionResponse>(this.route(id) + "/sandbox", { mode }));
  }
  private requireSandbox() {
    if (!this.state.library?.allowedSandboxModes?.length)
      throw new Error("当前 Bot 尚不支持沙盒，请更新 Bot 并重新连接。");
  }
  async decideApproval(id: string, requestId: string, approved: boolean) {
    return this.session(
      await this.request<SessionResponse>(
        this.route(id) + `/approvals/${encodeURIComponent(requestId)}`,
        { approved },
      ),
    );
  }
  async metadata(id: string, body: object) {
    const result = await this.request<ThreadMetadata>(this.route(id) + "/metadata", body);
    await this.refresh(true);
    return this.thread(result);
  }
  move(id: string, projectId: string | null) {
    return this.metadata(id, {
      action: "move",
      projectId: projectId === null ? null : this.raw(projectId),
    });
  }
  command<T>(id: string, action: string, body: object = {}) {
    return this.request<T>(this.route(id) + "/" + action, body);
  }
  async remove(id: string) {
    await this.command(id, "metadata", { action: "delete" });
    await this.refresh(true);
  }
  skills(workspaceId: string) {
    return this.request<Awaited<ReturnType<LocalDesktopApplication["skills"]>>>(
      `/v1/skills?workspaceId=${encodeURIComponent(this.raw(workspaceId))}`,
    );
  }

  async subscribeThread(
    id: string,
    onSnapshot: (value: SnapshotResponse) => void | Promise<void>,
    onError: (message: string) => void,
    path?: string,
  ) {
    const route = this.route(id) + "/events" + (path ? `?path=${encodeURIComponent(path)}` : "");
    const controller = new AbortController();
    this.streams.add(controller);
    const watch = async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await this.response(route, undefined, controller.signal);
          if (!response.body) throw new Error("Bot 未提供实时消息流");
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (!controller.signal.aborted) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
              let end: number;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const block = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const event = block
                  .split("\n")
                  .find((line) => line.startsWith("event:"))
                  ?.slice(6)
                  .trim();
                const data = block
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n");
                if (event === "snapshot") await onSnapshot(JSON.parse(data) as SnapshotResponse);
                if (event === "error")
                  throw new Error((JSON.parse(data) as { message: string }).message);
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
          if (!controller.signal.aborted) throw new Error("Bot 连接中断，正在重连");
        } catch (error) {
          if (controller.signal.aborted) break;
          onError(error instanceof Error ? error.message : "Bot 连接失败");
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 2000);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    };
    void watch().finally(() => this.streams.delete(controller));
    return () => controller.abort();
  }
  close() {
    ++this.generation;
    this.cancelStreams();
    clearInterval(this.timer);
    this.listeners.clear();
  }
}

export function withBot(local: LocalDesktopApplication, bot: DesktopBot) {
  const choose = async (value: Promise<SessionResponse>) => {
    const opened = await value;
    await local.updateSettings({ activeThreadId: opened.id });
    return opened;
  };
  return {
    ...local,
    importBotCredentials: async () => {
      const credentials = await local.exportBotCredentials();
      if (!Object.keys(credentials).length) throw new Error("客户端没有可导入的模型凭证");
      const result = await bot.request<{ imported: number }>("/v1/credentials/import", {
        credentials,
      });
      await bot.refresh(true);
      return result;
    },
    removeBotCredential: async (providerId: string) => {
      await bot.request("/v1/credentials/remove", { providerId });
      await bot.refresh(true);
    },
    createCloudProject: (name: string, requestId: string) => bot.createProject(name, requestId),
    connectBot: (connection: BotConnection) => bot.connect(connection),
    disconnectBot: () => bot.disconnect(),
    reconnectBot: async () => {
      await bot.refresh(true);
      return bot.status();
    },
    subscribeLibrary: (listener: () => void) => {
      const a = local.subscribeLibrary(listener);
      const b = bot.subscribe(listener);
      return () => {
        a();
        b();
      };
    },
    library: async () => {
      const library = await local.library();
      const state = bot.status();
      return {
        ...library,
        bot: state,
        projects: [...library.projects, ...(state.library?.projects ?? [])],
        workspaces: [...library.workspaces, ...(state.library?.workspaces ?? [])],
        threads: [...library.threads, ...(state.library?.threads ?? [])],
      };
    },
    createThread: (id: string, requestId?: string, configuration?: CreateThreadConfiguration) =>
      isCloudId(id)
        ? choose(bot.create(id, requestId ?? crypto.randomUUID(), configuration))
        : local.createThread(id, requestId, configuration),
    openThread: (id: string) => (isCloudId(id) ? choose(bot.open(id)) : local.openThread(id)),
    configureThread: (...args: Parameters<LocalDesktopApplication["configureThread"]>) =>
      isCloudId(args[0]) ? choose(bot.configure(...args)) : local.configureThread(...args),
    configureSandbox: (...args: Parameters<LocalDesktopApplication["configureSandbox"]>) =>
      isCloudId(args[0]) ? choose(bot.configureSandbox(...args)) : local.configureSandbox(...args),
    decideApproval: (...args: Parameters<LocalDesktopApplication["decideApproval"]>) =>
      isCloudId(args[0]) ? choose(bot.decideApproval(...args)) : local.decideApproval(...args),
    submit: (...args: Parameters<LocalDesktopApplication["submit"]>) =>
      isCloudId(args[0])
        ? bot.command<Awaited<ReturnType<LocalDesktopApplication["submit"]>>>(args[0], "messages", {
            prompt: args[1],
            requestId: args[2] ?? crypto.randomUUID(),
            ...(args[3] ? { images: args[3] } : {}),
          })
        : local.submit(...args),
    stop: (id: string) => (isCloudId(id) ? bot.command<void>(id, "stop") : local.stop(id)),
    resume: (id: string) => (isCloudId(id) ? bot.command<void>(id, "resume") : local.resume(id)),
    compact: (id: string) => (isCloudId(id) ? bot.command<void>(id, "compact") : local.compact(id)),
    renameThread: (id: string, title: string) =>
      isCloudId(id) ? bot.metadata(id, { action: "rename", title }) : local.renameThread(id, title),
    archiveThread: (id: string, archived: boolean) =>
      isCloudId(id)
        ? bot.metadata(id, { action: "archive", archived })
        : local.archiveThread(id, archived),
    moveThread: (id: string, projectId: string | null) => {
      if (projectId !== null && isCloudId(id) !== isCloudId(projectId))
        return Promise.reject(new Error("会话只能在同一执行环境内调整项目"));
      return isCloudId(id) ? bot.move(id, projectId) : local.moveThread(id, projectId);
    },
    deleteThread: (id: string) => (isCloudId(id) ? bot.remove(id) : local.deleteThread(id)),
    threadFile: (id: string) =>
      isCloudId(id) ? Promise.reject(new Error("云端会话文件保存在 Bot 上")) : local.threadFile(id),
    subagent: (...args: Parameters<LocalDesktopApplication["subagent"]>) =>
      isCloudId(args[0])
        ? bot.command<Awaited<ReturnType<LocalDesktopApplication["subagent"]>>>(
            args[0],
            "subagent",
            { command: args[1], requestId: args[2] },
          )
        : local.subagent(...args),
    unloadSkill: (id: string, name: string) =>
      isCloudId(id) ? bot.command<void>(id, "unload-skill", { name }) : local.unloadSkill(id, name),
    skills: (cwd?: string, workspaceId?: string) =>
      isCloudId(workspaceId) ? bot.skills(workspaceId!) : local.skills(cwd),
    subscribe: (...args: Parameters<LocalDesktopApplication["subscribe"]>) =>
      isCloudId(args[0]) ? bot.subscribeThread(...args) : local.subscribe(...args),
    close: async () => {
      bot.close();
      await local.close();
    },
  };
}
