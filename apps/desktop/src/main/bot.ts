import {
  ScheduleSnapshotSchema,
  ScheduleRequestSchema,
  ScheduleOccurrenceSchema,
} from "@eta/core/shared/schedules";
import type { ScheduleSnapshot, ScheduleRequest } from "@eta/core/shared/schedules";
import type {
  ScheduleWriteInput,
  ScheduleProposeInput,
  ScheduleDecisionInput,
  ScheduleRunInput,
} from "@eta/core/service/schedules/management";
import type { DesktopScheduleSnapshot } from "../shared/schedules.ts";
import {
  mapScheduleSnapshot,
  mapScheduleRequest,
  mapScheduleChange,
  mapScheduleRun,
} from "./schedule-identities.ts";
import type { CreateThreadConfiguration } from "@eta/core/agent/protocol";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { Schema } from "effect";
import type { BotLibrary } from "@eta/core/shared/bot";
import type {
  SessionResponse,
  SnapshotResponse,
  OperationAdmission,
} from "@eta/core/agent/protocol";
import type { ProjectMetadata } from "@eta/core/shared/projects";
import type { ThreadMetadata } from "@eta/core/shared/threads";
import type { BotConnection, BotState } from "../shared/bot.ts";
import { isCloudId } from "../shared/bot.ts";
import { BotConnectionSchema } from "./bot-schema.ts";
import type { LocalDesktopApplication } from "./bootstrap.ts";
import type { GitBranch, GitRepositoryInfo, WorktreeSummary } from "@eta/core/shared/git";
import type { CreateWorktreeInput } from "@eta/core/service/git/worktrees";
import type { GitHubIdentity, GitHubPage, GitHubQuery } from "@eta/core/shared/github";

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
  private scheduleCache?: ScheduleSnapshot;
  private scheduleCacheUrl?: string;
  private scheduleError?: string;
  private readonly scheduleListeners = new Set<() => void>();
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private scheduleRefresh?: Promise<void>;

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
    for (const listener of this.scheduleListeners) listener();
    for (const listener of this.listeners) listener();
  }
  private cancelStreams() {
    for (const controller of this.streams) controller.abort();
    this.streams.clear();
  }

  async connect(connection: BotConnection) {
    const candidate = new DesktopBot(this.dataRoot);
    candidate.use(connection);
    const [library, capabilities] = await Promise.all([
      candidate.request<BotLibrary>("/v1/library").then((value) => candidate.mapLibrary(value)),
      candidate.readCapabilities(),
    ]);
    ++this.generation;
    if (this.connection?.url !== candidate.connection!.url) this.cancelStreams();
    this.use(candidate.connection!);
    this.state = {
      status: "connected",
      url: this.connection!.url,
      library,
      capabilities,
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
    this.scheduleCache = undefined;
    this.scheduleCacheUrl = undefined;
    await rm(join(this.dataRoot, "bot-schedules.json"), { force: true });
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

  private async readCapabilities(): Promise<readonly string[]> {
    const status = await this.request<{ capabilities?: unknown }>("/v1/status").catch(() => ({}));
    // An older Bot can omit this field or the endpoint entirely.
    return "capabilities" in status && Array.isArray(status.capabilities)
      ? status.capabilities.filter((value): value is string => typeof value === "string")
      : [];
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
        const [library, capabilities] = await Promise.all([
          this.request<BotLibrary>("/v1/library").then((value) => this.mapLibrary(value)),
          this.readCapabilities(),
        ]);
        if (generation !== this.generation) return;
        const next: BotState = {
          status: "connected",
          url: this.connection!.url,
          library,
          // Older Bots omit the list; their features are then reported as unsupported.
          capabilities,
        };
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
  private snapshot(value: SnapshotResponse): SnapshotResponse {
    if (!value.snapshot) return value;
    return {
      ...value,
      snapshot: {
        ...value.snapshot,
        transcript: value.snapshot.transcript.map((entry) => ({
          ...entry,
          id: this.prefix + entry.id,
        })),
        operation: value.snapshot.operation
          ? {
              ...value.snapshot.operation,
              id: this.prefix + value.snapshot.operation.id,
              ...(value.snapshot.operation.inputEntryId
                ? { inputEntryId: this.prefix + value.snapshot.operation.inputEntryId }
                : {}),
            }
          : null,
        lastResult: value.snapshot.lastResult
          ? {
              ...value.snapshot.lastResult,
              operationId: this.prefix + value.snapshot.lastResult.operationId,
              ...(value.snapshot.lastResult.inputEntryId
                ? { inputEntryId: this.prefix + value.snapshot.lastResult.inputEntryId }
                : {}),
            }
          : null,
      },
    };
  }
  private session(value: SessionResponse): SessionResponse {
    return { ...value, ...this.snapshot(value), id: this.prefix + value.id };
  }

  private async response(
    path: string,
    body?: object,
    signal?: AbortSignal,
    method?: string,
    acceptedStatuses: readonly number[] = [],
  ) {
    if (!this.connection) throw new Error("请先连接 Bot");
    const response = await fetch(this.connection.url + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
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
    // A restored thread includes its full history. Keep the deadline alive through body reads,
    // while ordinary control requests retain their short timeout and SSE has its own lifetime.
    const snapshotResponse =
      /^\/v1\/threads\/[^/]+(?:\/(?:configure|sandbox|approvals\/[^/]+))?$/.test(path);
    const timeout = snapshotResponse ? 120000 : 10000;
    const signal = AbortSignal.timeout(timeout);
    try {
      return (await (await this.response(path, body, signal)).json()) as T;
    } catch (error) {
      if (signal.aborted) throw new Error("连接 Bot 超时，请检查网络后重试。", { cause: error });
      throw error;
    }
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
  async decideApproval(id: string, requestId: string, approved: boolean, reuse?: "call" | "run") {
    return this.session(
      await this.request<SessionResponse>(
        this.route(id) + `/approvals/${encodeURIComponent(requestId)}`,
        { approved, ...(reuse ? { reuse } : {}) },
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
  async submit(
    ...args: Parameters<LocalDesktopApplication["submit"]>
  ): Promise<OperationAdmission> {
    const receipt = await this.command<OperationAdmission>(args[0], "messages", {
      prompt: args[1],
      requestId: args[2] ?? crypto.randomUUID(),
      ...(args[3] ? { images: args[3] } : {}),
    });
    return {
      ...receipt,
      operationId: this.prefix + receipt.operationId,
      ...(receipt.inputEntryId ? { inputEntryId: this.prefix + receipt.inputEntryId } : {}),
    };
  }
  command<T>(id: string, action: string, body: object = {}) {
    return this.request<T>(this.route(id) + "/" + action, body);
  }
  async remove(id: string) {
    await this.command(id, "metadata", { action: "delete" });
    await this.refresh(true);
  }
  private worktree(value: WorktreeSummary): WorktreeSummary {
    return {
      ...value,
      projectId: this.prefix + value.projectId,
      ...(value.workspaceId ? { workspaceId: this.prefix + value.workspaceId } : {}),
      ...(value.continues ? { continues: this.prefix + value.continues } : {}),
    };
  }
  private get capabilities() {
    return this.state.capabilities ?? [];
  }
  private requireCapability(name: string) {
    if (!this.capabilities.includes(name))
      throw new Error("当前 Bot 版本不支持此功能，请更新 Bot 后重新连接。");
  }
  async gitRepository(workspaceId: string): Promise<GitRepositoryInfo> {
    this.requireCapability("git");
    const info = await this.request<GitRepositoryInfo>(
      `/v1/workspaces/${encodeURIComponent(this.raw(workspaceId))}/git`,
    );
    return { ...info, workspaceId };
  }
  githubIdentity(projectId: string) {
    this.requireCapability("github");
    return this.request<GitHubIdentity>(
      `/v1/projects/${encodeURIComponent(this.raw(projectId))}/github/identity`,
    );
  }
  async githubQuery(input: GitHubQuery): Promise<GitHubPage> {
    this.requireCapability("github");
    const page = await this.request<GitHubPage>(
      `/v1/projects/${encodeURIComponent(this.raw(input.projectId))}/github`,
      { ...input, projectId: undefined },
    );
    const repository = (value: NonNullable<GitHubPage["repository"]>) => ({
      ...value,
      projectId: this.prefix + value.projectId,
      workspaceId: this.prefix + value.workspaceId,
    });
    return page.status === "ready"
      ? { ...page, repository: repository(page.repository) }
      : {
          ...page,
          ...(page.repository ? { repository: repository(page.repository) } : {}),
          ...(page.cached
            ? { cached: { ...page.cached, repository: repository(page.cached.repository) } }
            : {}),
        };
  }
  gitBranches(workspaceId: string) {
    this.requireCapability("git");
    return this.request<GitBranch[]>(
      `/v1/workspaces/${encodeURIComponent(this.raw(workspaceId))}/branches`,
    );
  }
  async selectGitHubRemote(projectId: string, remoteName: string | null, requestId?: string) {
    this.requireCapability("git");
    const info = await this.request<GitRepositoryInfo>(
      `/v1/projects/${encodeURIComponent(this.raw(projectId))}/github-remote`,
      { remoteName, ...(requestId ? { requestId } : {}) },
    );
    return { ...info, workspaceId: this.prefix + info.workspaceId };
  }
  async listWorktrees(projectId: string) {
    this.requireCapability("worktree");
    return (
      await this.request<WorktreeSummary[]>(
        `/v1/projects/${encodeURIComponent(this.raw(projectId))}/worktrees`,
      )
    ).map((value) => this.worktree(value));
  }
  async reconcileWorktrees(projectId: string) {
    this.requireCapability("worktree");
    const result = await this.request<WorktreeSummary[]>(
      `/v1/projects/${encodeURIComponent(this.raw(projectId))}/worktrees/reconcile`,
      {},
    );
    await this.refresh(true);
    return result.map((value) => this.worktree(value));
  }
  async createWorktree(input: CreateWorktreeInput) {
    this.requireCapability("worktree");
    const created = await this.request<WorktreeSummary>(
      `/v1/projects/${encodeURIComponent(this.raw(input.projectId))}/worktrees`,
      {
        baseWorkspaceId: this.raw(input.baseWorkspaceId),
        branch: input.branch,
        requestId: input.requestId,
        ...(input.continuesWorkspaceId
          ? { continuesWorkspaceId: this.raw(input.continuesWorkspaceId) }
          : {}),
      },
    );
    // The new workspace must be in the library before a thread can be created in it.
    await this.refresh(true);
    return this.worktree(created);
  }
  async removeWorktree(workspaceId: string, requestId: string) {
    this.requireCapability("worktree");
    const removed = await this.request<WorktreeSummary>(
      `/v1/workspaces/${encodeURIComponent(this.raw(workspaceId))}/remove`,
      { requestId },
    );
    await this.refresh(true);
    return this.worktree(removed);
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
                if (event === "snapshot")
                  await onSnapshot(this.snapshot(JSON.parse(data) as SnapshotResponse));
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

  private async refreshSchedules() {
    if (
      !this.connection ||
      this.state.status !== "connected" ||
      !this.capabilities.includes("schedules")
    )
      return;
    if (this.scheduleRefresh) return this.scheduleRefresh;
    const generation = this.generation;
    const url = this.connection.url;
    this.scheduleRefresh = (async () => {
      const raw = await this.request<unknown>("/v1/schedules");
      if (generation !== this.generation) return;
      const next = Schema.decodeUnknownSync(ScheduleSnapshotSchema)(raw);
      const changed =
        this.scheduleCacheUrl !== url || this.scheduleCache?.revision !== next.revision;
      const recovered = !!this.scheduleError;
      this.scheduleError = undefined;
      this.scheduleCache = next;
      this.scheduleCacheUrl = url;
      if (changed || recovered) {
        await writeFile(
          join(this.dataRoot, "bot-schedules.json"),
          JSON.stringify({ url, data: next }),
          { mode: 0o600 },
        );
        for (const listener of this.scheduleListeners) listener();
      }
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "无法读取 Bot 定时任务";
        if (generation === this.generation && this.scheduleError !== message) {
          this.scheduleError = message;
          for (const listener of this.scheduleListeners) listener();
        }
        throw error;
      })
      .finally(() => {
        this.scheduleRefresh = undefined;
      });
    return this.scheduleRefresh;
  }
  async scheduleSnapshot(): Promise<DesktopScheduleSnapshot["snapshots"][number] | undefined> {
    if (!this.connection) return;
    if (!this.scheduleCache) {
      const cached = await readFile(join(this.dataRoot, "bot-schedules.json"), "utf8")
        .then((raw) =>
          Schema.decodeUnknownSync(
            Schema.Struct({ url: Schema.String, data: ScheduleSnapshotSchema }),
          )(JSON.parse(raw)),
        )
        .catch(() => undefined);
      if (cached?.url === this.connection.url) {
        this.scheduleCache = cached.data;
        this.scheduleCacheUrl = cached.url;
      }
    }
    await this.refreshSchedules().catch(() => undefined);
    const supported = this.capabilities.includes("schedules");
    const online = this.state.status === "connected" && !this.scheduleError;
    return {
      environment: {
        id: this.prefix,
        label: "Bot",
        status:
          !supported && this.state.status === "connected"
            ? "unsupported"
            : online
              ? "connected"
              : "offline",
        ...(!supported && this.state.status === "connected"
          ? { message: "当前 Bot 版本不支持定时任务" }
          : !online
            ? { message: "缓存可能过期；Bot 可能仍在执行" }
            : {}),
      },
      data: mapScheduleSnapshot(
        this.scheduleCacheUrl === this.connection.url && this.scheduleCache
          ? this.scheduleCache
          : { revision: 0, schedules: [], proposals: [], requests: [], lifecycleIntents: [] },
        (id) => this.prefix + id,
      ),
    };
  }
  subscribeSchedules(listener: () => void) {
    this.scheduleListeners.add(listener);
    if (!this.scheduleTimer) {
      this.scheduleTimer = setInterval(() => {
        void this.refreshSchedules().catch(() => undefined);
      }, 15000);
      this.scheduleTimer.unref();
    }
    return () => {
      this.scheduleListeners.delete(listener);
      if (!this.scheduleListeners.size) {
        clearInterval(this.scheduleTimer);
        this.scheduleTimer = undefined;
      }
    };
  }
  private async scheduleMutation(
    path: string,
    body: object,
    method = "POST",
  ): Promise<ScheduleRequest> {
    this.requireCapability("schedules");
    if (this.state.status !== "connected" || this.scheduleError)
      throw new Error("Bot 离线，无法更改定时任务；原计划可能仍在执行");
    const response = await this.response(path, body, undefined, method, [409]);
    const result = Schema.decodeUnknownSync(ScheduleRequestSchema)(await response.json());
    await this.refreshSchedules().catch(() => undefined);
    return mapScheduleRequest(result, (id) => this.prefix + id);
  }
  writeSchedule(input: ScheduleWriteInput) {
    const change = mapScheduleChange(input.change, (id) => this.raw(id));
    const path =
      change.action === "create"
        ? `${this.route(input.threadId)}/schedules`
        : `/v1/schedules/${encodeURIComponent(change.scheduleId)}`;
    if (change.action === "create") {
      const { action: _action, ...fields } = change;
      return this.scheduleMutation(path, { ...fields, requestId: input.requestId });
    }
    this.raw(input.threadId);
    const { action, scheduleId: _scheduleId, ...body } = change;
    return this.scheduleMutation(
      path + (["pause", "resume"].includes(action) ? `/${action}` : ""),
      { ...body, requestId: input.requestId },
      action === "delete" ? "DELETE" : action === "update" ? "PATCH" : "POST",
    );
  }
  proposeSchedule(input: ScheduleProposeInput) {
    return this.scheduleMutation(`${this.route(input.threadId)}/schedule-proposals`, {
      requestId: input.requestId,
      change: mapScheduleChange(input.change, (id) => this.raw(id)),
      ...(input.replaces
        ? { replaces: { ...input.replaces, proposalId: this.raw(input.replaces.proposalId) } }
        : {}),
    });
  }
  decideSchedule(input: ScheduleDecisionInput, approved: boolean) {
    return this.scheduleMutation(
      `/v1/schedule-proposals/${encodeURIComponent(this.raw(input.proposalId))}/${approved ? "approve" : "reject"}`,
      { requestId: input.requestId, contentFingerprint: input.contentFingerprint },
    );
  }
  runSchedule(input: ScheduleRunInput) {
    this.raw(input.threadId);
    return this.scheduleMutation(
      `/v1/schedules/${encodeURIComponent(this.raw(input.scheduleId))}/run`,
      { requestId: input.requestId, expectedRevision: input.expectedRevision },
    );
  }
  async scheduleRuns(scheduleId: string) {
    this.requireCapability("schedules");
    const value = await this.request<{ runs: unknown }>(
      `/v1/schedules/${encodeURIComponent(this.raw(scheduleId))}/runs`,
    );
    return Schema.decodeUnknownSync(Schema.Array(ScheduleOccurrenceSchema))(value.runs).map((run) =>
      mapScheduleRun(run, (id) => this.prefix + id),
    );
  }
  async scheduleRequest(threadId: string, requestId: string) {
    this.requireCapability("schedules");
    this.raw(threadId);
    const value = await this.request<unknown>(
      `/v1/schedule-requests/${encodeURIComponent(requestId)}`,
    );
    return mapScheduleRequest(
      Schema.decodeUnknownSync(ScheduleRequestSchema)(value),
      (id) => this.prefix + id,
    );
  }
  close() {
    ++this.generation;
    this.cancelStreams();
    clearInterval(this.timer);
    this.listeners.clear();
    clearInterval(this.scheduleTimer);
    this.scheduleListeners.clear();
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
    scheduleSnapshot: async (): Promise<DesktopScheduleSnapshot> => {
      const [data, remote] = await Promise.all([local.scheduleSnapshot(), bot.scheduleSnapshot()]);
      return {
        snapshots: [
          { environment: { id: "local", label: "本地", status: "connected" }, data },
          ...(remote ? [remote] : []),
        ],
      };
    },
    writeSchedule: (input: ScheduleWriteInput) =>
      isCloudId(input.threadId) ? bot.writeSchedule(input) : local.writeSchedule(input),
    proposeSchedule: (input: ScheduleProposeInput) =>
      isCloudId(input.threadId) ? bot.proposeSchedule(input) : local.proposeSchedule(input),
    decideSchedule: (input: ScheduleDecisionInput, approved: boolean) =>
      isCloudId(input.proposalId)
        ? bot.decideSchedule(input, approved)
        : local.decideSchedule(input, approved),
    runSchedule: (input: ScheduleRunInput) =>
      isCloudId(input.threadId) ? bot.runSchedule(input) : local.runSchedule(input),
    scheduleRuns: (id: string) => (isCloudId(id) ? bot.scheduleRuns(id) : local.scheduleRuns(id)),
    scheduleRequest: (threadId: string, requestId: string) =>
      isCloudId(threadId)
        ? bot.scheduleRequest(threadId, requestId)
        : local.scheduleRequest(threadId, requestId),
    subscribeSchedules: (listener: () => void) => {
      const a = local.subscribeSchedules(listener);
      const b = bot.subscribeSchedules(listener);
      return () => {
        a();
        b();
      };
    },
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
    gitRepository: (workspaceId: string) =>
      isCloudId(workspaceId) ? bot.gitRepository(workspaceId) : local.gitRepository(workspaceId),
    githubIdentity: (projectId: string) =>
      isCloudId(projectId) ? bot.githubIdentity(projectId) : local.githubIdentity(projectId),
    githubQuery: (input: GitHubQuery) =>
      isCloudId(input.projectId) ? bot.githubQuery(input) : local.githubQuery(input),
    gitBranches: (workspaceId: string) =>
      isCloudId(workspaceId) ? bot.gitBranches(workspaceId) : local.gitBranches(workspaceId),
    selectGitHubRemote: (projectId: string, remoteName: string | null, requestId?: string) =>
      isCloudId(projectId)
        ? bot.selectGitHubRemote(projectId, remoteName, requestId)
        : local.selectGitHubRemote(projectId, remoteName, requestId),
    listWorktrees: (projectId: string) =>
      isCloudId(projectId) ? bot.listWorktrees(projectId) : local.listWorktrees(projectId),
    reconcileWorktrees: (projectId: string) =>
      isCloudId(projectId)
        ? bot.reconcileWorktrees(projectId)
        : local.reconcileWorktrees(projectId),
    createWorktree: (input: CreateWorktreeInput) =>
      isCloudId(input.projectId) ? bot.createWorktree(input) : local.createWorktree(input),
    removeWorktree: (workspaceId: string, requestId: string) =>
      isCloudId(workspaceId)
        ? bot.removeWorktree(workspaceId, requestId)
        : local.removeWorktree(workspaceId, requestId),
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
      isCloudId(args[0]) ? bot.submit(...args) : local.submit(...args),
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
