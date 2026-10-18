import { z } from "zod";
import { BotClient, BotError } from "./client.ts";
import { ConfigurationSchema, LibrarySchema } from "./contracts.ts";
import type {
  BotLibrary,
  Configuration,
  Connection,
  OpenThread,
  SnapshotResponse,
} from "./contracts.ts";

const PendingSchema = z.object({
  workspaceId: z.string(),
  threadId: z.string().optional(),
  prompt: z.string(),
  createId: z.string(),
  messageId: z.string(),
  configuration: ConfigurationSchema,
});
export const CacheSchema = z.object({
  library: LibrarySchema.optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  drafts: z.record(z.string(), z.string()).default({}),
  pending: PendingSchema.optional(),
  lastConfiguration: ConfigurationSchema.optional(),
});
export type MobileCache = z.infer<typeof CacheSchema>;
export interface MobileStorage {
  connection(): Promise<Connection | undefined>;
  saveConnection(value: Connection | undefined): Promise<void>;
  cache(url: string): Promise<MobileCache | undefined>;
  saveCache(url: string, value: MobileCache): Promise<void>;
  clear(): Promise<void>;
}
export interface MobileState {
  status: "loading" | "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
  url?: string;
  error?: string;
  library?: BotLibrary;
  workspaceId?: string;
  threadId?: string;
  thread?: OpenThread;
  configuration?: Configuration;
  drafts: Record<string, string>;
  pending?: z.infer<typeof PendingSchema>;
  sending: boolean;
  opening: boolean;
  foreground: boolean;
}

export function defaultConfiguration(library: BotLibrary): Configuration | undefined {
  const settings = library.settings;
  const model =
    library.models.find(
      (value) =>
        (!settings.defaultProvider || value.provider === settings.defaultProvider) &&
        (!settings.defaultModel || value.id === settings.defaultModel),
    ) ?? library.models[0];
  if (!model) return;
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: model.thinkingLevels.includes(settings.defaultThinkingLevel)
      ? settings.defaultThinkingLevel
      : (model.thinkingLevels[0] ?? "off"),
    sandboxMode: settings.defaultSandboxMode ?? "workspace-write",
  };
}

export const draftKey = (state: Pick<MobileState, "threadId" | "workspaceId">) =>
  state.threadId ? `thread:${state.threadId}` : `workspace:${state.workspaceId ?? "none"}`;
const message = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试");

/** Coordinates remote work. Leaving a view or disconnecting only cancels observation. */
export class MobileStore {
  private state: MobileState = {
    status: "loading",
    drafts: {},
    sending: false,
    opening: false,
    foreground: true,
  };
  private listeners = new Set<() => void>();
  private client?: BotClient;
  private epoch = 0;
  private connectionAttempt = 0;
  private view = 0;
  private observer?: AbortController;
  private opener?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private storageTail: Promise<void> = Promise.resolve();
  private refreshing?: BotClient;
  private projectRequest?: { name: string; id: string };

  constructor(
    private readonly storage: MobileStorage,
    private readonly makeClient: (connection: Connection) => BotClient,
    private readonly uuid: () => string,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<MobileState>) {
    if (
      Object.entries(value).every(([key, value]) =>
        Object.is(this.state[key as keyof MobileState], value),
      )
    )
      return;
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  private write(action: () => Promise<void>) {
    const next = this.storageTail.catch(() => {}).then(action);
    this.storageTail = next;
    return next;
  }
  private persist() {
    const url = this.state.url;
    const epoch = this.epoch;
    if (!url) return Promise.resolve();
    const cache: MobileCache = {
      library: this.state.library,
      workspaceId: this.state.workspaceId,
      threadId: this.state.threadId,
      drafts: this.state.drafts,
      pending: this.state.pending,
      lastConfiguration: this.state.configuration,
    };
    return this.write(async () => {
      if (epoch === this.epoch) await this.storage.saveCache(url, cache);
    });
  }
  private saveLater() {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      void this.persist().catch((error) =>
        this.update({ error: `无法保存草稿：${message(error)}` }),
      );
    }, 300);
  }
  private stopObservation() {
    ++this.view;
    this.observer?.abort();
    this.opener?.abort();
    clearInterval(this.timer);
    clearTimeout(this.draftTimer);
  }
  private watch() {
    this.observer?.abort();
    const client = this.client;
    const id = this.state.threadId;
    if (!client || !id || !this.state.foreground) return;
    const epoch = this.epoch;
    const view = this.view;
    const controller = new AbortController();
    this.observer = controller;
    let next: SnapshotResponse | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (epoch !== this.epoch || view !== this.view || !this.state.thread || !next) return;
      const current = next;
      next = undefined;
      const configuration = current.snapshot.configuration;
      this.update({
        thread: { ...this.state.thread, ...current },
        configuration: {
          ...this.state.configuration,
          ...configuration.model,
          thinkingLevel: configuration.thinkingLevel,
        },
      });
    };
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true },
    );
    void client
      .watch(
        id,
        controller.signal,
        (snapshot) => {
          if (epoch !== this.epoch || view !== this.view || !this.state.thread) return;
          next = snapshot;
          // Coalesce token bursts; terminal state and approvals remain immediate.
          if (!snapshot.snapshot.operation || snapshot.snapshot.operation.waitingForApproval) {
            clearTimeout(timer);
            flush();
          } else if (!timer) timer = setTimeout(flush, 80);
        },
        (error, fatal) => {
          if (epoch !== this.epoch || view !== this.view) return;
          this.update({ status: error ? (fatal ? "error" : "reconnecting") : "connected", error });
        },
      )
      .catch((error) => {
        if (epoch === this.epoch && view === this.view)
          this.update({ status: "error", error: message(error) });
      });
  }
  private poll() {
    clearInterval(this.timer);
    if (this.client && this.state.foreground) {
      this.timer = setInterval(() => {
        void this.refresh();
      }, 15000);
    }
  }
  async initialize() {
    const epoch = this.epoch;
    try {
      const connection = await this.storage.connection();
      if (epoch !== this.epoch) return;
      if (!connection) {
        this.update({ status: "disconnected" });
        return;
      }
      this.client = this.makeClient(connection);
      const url = this.client.connection.url;
      const cache = await this.storage.cache(url);
      if (epoch !== this.epoch) return;
      this.update({ ...cache, url, status: "reconnecting" });
      if (cache?.library) {
        const remembered =
          cache.lastConfiguration &&
          cache.library.models.some(
            (m) =>
              m.provider === cache.lastConfiguration?.provider &&
              m.id === cache.lastConfiguration?.modelId,
          )
            ? cache.lastConfiguration
            : defaultConfiguration(cache.library);
        this.update({ configuration: remembered });
      }
      if (epoch !== this.epoch) return;
      await this.reconnect();
    } catch (error) {
      if (epoch === this.epoch) this.update({ status: "error", error: message(error) });
    }
  }
  async connect(connection: Connection) {
    if (this.state.sending) throw new Error("请等待当前消息提交完成");
    const candidate = this.makeClient(connection);
    // The old cache flush precedes the new epoch; preserve the latest call's intent.
    const attempt = ++this.connectionAttempt;
    await this.persist();
    if (attempt !== this.connectionAttempt) return;
    const epoch = ++this.epoch;
    this.stopObservation();
    this.update({ status: "connecting", error: undefined, opening: false });
    try {
      const library = await candidate.library();
      if (epoch !== this.epoch) return;
      const cache = await this.storage.cache(candidate.connection.url);
      await this.write(async () => {
        if (epoch === this.epoch) await this.storage.saveConnection(candidate.connection);
      });
      if (epoch !== this.epoch) return;
      this.client = candidate;
      this.update({
        url: candidate.connection.url,
        status: "connected",
        library,
        drafts: cache?.drafts ?? {},
        pending: cache?.pending,
        workspaceId: library.workspaces.some((value) => value.id === cache?.workspaceId)
          ? cache?.workspaceId
          : library.workspaces[0]?.id,
        threadId: library.threads.some((value) => value.id === cache?.threadId)
          ? cache?.threadId
          : undefined,
        thread: undefined,
        configuration:
          cache?.lastConfiguration &&
          library.models.some(
            (m) =>
              m.provider === cache.lastConfiguration?.provider &&
              m.id === cache.lastConfiguration?.modelId,
          )
            ? cache.lastConfiguration
            : defaultConfiguration(library),
        sending: false,
      });
      await this.persist();
      if (epoch !== this.epoch) return;
      if (this.state.threadId) await this.open(this.state.threadId);
      if (epoch !== this.epoch) return;
      this.poll();
    } catch (error) {
      if (epoch !== this.epoch) return;
      // Before commit the old client is unchanged; after commit it must match the new state.
      this.update({ status: "error", error: message(error) });
      this.poll();
      throw error;
    }
  }
  async disconnect(forget = false) {
    ++this.connectionAttempt;
    if (!forget) await this.persist();
    ++this.epoch;
    this.stopObservation();
    this.client = undefined;
    this.projectRequest = undefined;
    this.update({
      status: "disconnected",
      url: undefined,
      library: undefined,
      threadId: undefined,
      thread: undefined,
      workspaceId: undefined,
      configuration: undefined,
      error: undefined,
      pending: undefined,
      drafts: {},
      sending: false,
      opening: false,
    });
    await this.write(() =>
      forget ? this.storage.clear() : this.storage.saveConnection(undefined),
    );
  }
  async reconnect() {
    if (!this.client) return;
    const epoch = this.epoch;
    this.update({ status: "reconnecting", error: undefined });
    await this.refresh();
    if (epoch !== this.epoch) return;
    if (this.state.status === "connected" && this.state.threadId && !this.state.sending)
      await this.open(this.state.threadId);
    if (epoch !== this.epoch) return;
    this.poll();
  }
  async refresh() {
    const client = this.client;
    if (!client || this.refreshing === client || !this.state.foreground) return;
    const epoch = this.epoch;
    this.refreshing = client;
    try {
      const library = await client.library();
      if (epoch !== this.epoch || client !== this.client) return;
      const selected = library.threads.find((thread) => thread.id === this.state.threadId);
      if (this.state.threadId && !selected && !this.state.pending) {
        this.observer?.abort();
        ++this.view;
        this.update({ threadId: undefined, thread: undefined });
      }
      this.update({
        library,
        status: "connected",
        error: undefined,
        workspaceId: library.workspaces.some((workspace) => workspace.id === this.state.workspaceId)
          ? this.state.workspaceId
          : library.workspaces[0]?.id,
        ...(selected && this.state.thread
          ? { thread: { ...this.state.thread, thread: selected } }
          : {}),
        configuration: this.state.configuration ?? defaultConfiguration(library),
      });
      await this.persist();
    } catch (error) {
      if (epoch !== this.epoch || client !== this.client) return;
      this.update({ status: "error", error: message(error) });
      if (error instanceof BotError && error.status === 401) this.observer?.abort();
    } finally {
      if (this.refreshing === client) this.refreshing = undefined;
    }
  }
  async open(id: string) {
    if (this.state.sending) throw new Error("请等待当前消息提交完成");
    const client = this.requireClient();
    this.observer?.abort();
    this.opener?.abort();
    const epoch = this.epoch;
    const view = ++this.view;
    const controller = new AbortController();
    this.opener = controller;
    const metadata = this.state.library?.threads.find((thread) => thread.id === id);
    this.update({
      threadId: id,
      thread: undefined,
      opening: true,
      error: undefined,
      workspaceId: metadata?.workspaceId ?? this.state.workspaceId,
    });
    this.saveLater();
    try {
      const thread = await client.open(id, controller.signal);
      if (epoch !== this.epoch || view !== this.view) return;
      this.useThread(thread);
      await this.persist();
      if (epoch !== this.epoch || view !== this.view) return;
      this.watch();
    } catch (error) {
      if (epoch !== this.epoch || view !== this.view) return;
      this.update({ opening: false, error: message(error) });
    }
  }
  private useThread(thread: OpenThread) {
    const config = thread.snapshot.configuration;
    this.update({
      threadId: thread.id,
      thread,
      workspaceId: thread.thread.workspaceId,
      opening: false,
      configuration: {
        ...config.model,
        thinkingLevel: config.thinkingLevel,
        sandboxMode: thread.snapshot.sandbox?.mode,
      },
    });
  }
  newThread(workspaceId = this.state.workspaceId) {
    if (this.state.sending) throw new Error("请等待当前消息提交完成");
    this.observer?.abort();
    this.opener?.abort();
    ++this.view;
    this.update({
      workspaceId,
      threadId: undefined,
      thread: undefined,
      opening: false,
      error: undefined,
      configuration:
        this.state.configuration ??
        (this.state.library ? defaultConfiguration(this.state.library) : undefined),
    });
    this.saveLater();
  }
  setDraft(value: string) {
    this.update({ drafts: { ...this.state.drafts, [draftKey(this.state)]: value } });
    this.saveLater();
  }
  private requireClient() {
    if (!this.client || this.state.status !== "connected") throw new Error("请先连接 Bot");
    return this.client;
  }
  async send() {
    if (this.state.sending) return;
    this.requireClient();
    if (this.state.pending) throw new Error("请先确认上一次消息的接收状态");
    const prompt = this.state.drafts[draftKey(this.state)] ?? "";
    if (!prompt.trim()) return;
    if (!this.state.workspaceId || !this.state.configuration) throw new Error("请先选择项目和模型");
    if (this.state.threadId && !this.state.thread) throw new Error("请先等待会话加载完成");
    if (this.state.thread?.thread.archivedAt) throw new Error("请先取消归档再发送消息");
    if (this.state.thread?.snapshot.operation) throw new Error("当前会话正在执行任务");
    if (
      this.state.thread?.snapshot.recoveryRequired ||
      this.state.thread?.snapshot.blockedReason ||
      this.state.thread?.snapshot.faulted
    )
      throw new Error(this.state.thread.snapshot.blockedReason ?? "请先恢复当前任务");
    this.update({
      pending: {
        prompt,
        workspaceId: this.state.workspaceId,
        threadId: this.state.threadId,
        configuration: this.state.configuration,
        createId: this.uuid(),
        messageId: this.uuid(),
      },
    });
    await this.retrySend();
  }
  async retrySend() {
    if (this.state.sending || !this.state.pending) return;
    const client = this.requireClient();
    const epoch = this.epoch;
    let pending = this.state.pending;
    this.update({ sending: true, error: undefined });
    try {
      // Persist both IDs before the first request; a process death can then be retried safely.
      await this.persist();
      if (epoch !== this.epoch) return;
      if (!pending.threadId) {
        const thread = await client.create(
          pending.workspaceId,
          pending.createId,
          pending.configuration,
        );
        if (epoch !== this.epoch) return;
        pending = { ...pending, threadId: thread.id };
        const drafts = { ...this.state.drafts };
        const key = `workspace:${pending.workspaceId}`;
        if (drafts[key] === pending.prompt) {
          drafts[`thread:${thread.id}`] = pending.prompt;
          delete drafts[key];
        }
        this.update({ pending, drafts });
        this.useThread(thread);
        if (this.state.library)
          this.update({
            library: {
              ...this.state.library,
              threads: [
                ...this.state.library.threads.filter((value) => value.id !== thread.id),
                thread.thread,
              ],
            },
          });
        await this.persist();
        if (epoch !== this.epoch) return;
        this.watch();
      }
      await client.send(pending.threadId!, pending.prompt, pending.messageId);
      if (epoch !== this.epoch) return;
      const key = `thread:${pending.threadId}`;
      const originalKey =
        this.state.drafts[key] === pending.prompt ? key : `workspace:${pending.workspaceId}`;
      const drafts = { ...this.state.drafts };
      if (drafts[originalKey] === pending.prompt) delete drafts[originalKey];
      this.update({
        pending: undefined,
        drafts,
        sending: false,
      });
      await this.persist();
      if (epoch !== this.epoch) return;
      await this.refresh();
      if (epoch !== this.epoch) return;
      if (this.state.threadId === pending.threadId) await this.open(pending.threadId!);
    } catch (error) {
      if (epoch !== this.epoch) return;
      // An explicit rejection means the server did not admit this input. A timeout stays unresolved.
      const rejected =
        error instanceof BotError && error.status !== undefined && error.status < 500;
      this.update({
        sending: false,
        error: message(error),
        ...(rejected ? { pending: undefined } : {}),
      });
      await this.persist();
      throw error;
    } finally {
      if (epoch === this.epoch) this.update({ sending: false });
    }
  }
  async createProject(name: string) {
    const client = this.requireClient();
    const epoch = this.epoch;
    if (!this.projectRequest || this.projectRequest.name !== name)
      this.projectRequest = { name, id: this.uuid() };
    const project = await client.project(name, this.projectRequest.id);
    if (epoch !== this.epoch) return;
    this.projectRequest = undefined;
    await this.refresh();
    if (epoch !== this.epoch) return;
    const workspace = this.state.library?.workspaces.find(
      (value) => value.projectId === project.id && value.kind === "project-root",
    );
    if (workspace) this.newThread(workspace.id);
  }
  async configure(configuration: Configuration) {
    if (this.state.sending || this.state.pending) throw new Error("请先确认当前消息的接收状态");
    const client = this.requireClient();
    const epoch = this.epoch;
    const view = this.view;
    const id = this.state.threadId;
    if (this.state.thread?.snapshot.operation) throw new Error("请等待当前任务结束再更改配置");
    if (!id) {
      this.update({ configuration });
      await this.persist();
      return;
    }
    if (!this.state.thread) throw new Error("请先等待会话加载完成");
    let thread = await client.configure(id, configuration);
    if (epoch !== this.epoch || view !== this.view) return;
    this.useThread(thread);
    if (configuration.sandboxMode && configuration.sandboxMode !== thread.snapshot.sandbox?.mode) {
      thread = await client.sandbox(id, configuration.sandboxMode);
      if (epoch !== this.epoch || view !== this.view) return;
      this.useThread(thread);
    }
    await this.persist();
  }
  async control(action: "stop" | "resume") {
    const client = this.requireClient();
    const id = this.state.threadId;
    const epoch = this.epoch;
    const view = this.view;
    if (!id) return;
    await client[action](id);
    if (epoch === this.epoch && view === this.view) await this.open(id);
  }
  async approve(requestId: string, approved: boolean, reuse?: "call" | "run") {
    const client = this.requireClient();
    const id = this.state.threadId;
    const epoch = this.epoch;
    const view = this.view;
    if (!id) return;
    const thread = await client.approve(id, requestId, approved, reuse);
    if (epoch === this.epoch && view === this.view) this.useThread(thread);
  }
  async metadata(id: string, action: { title: string } | { archived: boolean }) {
    const client = this.requireClient();
    const epoch = this.epoch;
    const thread =
      "title" in action
        ? await client.rename(id, action.title)
        : await client.archive(id, action.archived);
    if (epoch !== this.epoch) return;
    if (this.state.library)
      this.update({
        library: {
          ...this.state.library,
          threads: this.state.library.threads.map((value) => (value.id === id ? thread : value)),
        },
      });
    if (this.state.threadId === id && this.state.thread)
      this.update({ thread: { ...this.state.thread, thread } });
    await this.persist();
  }
  setForeground(foreground: boolean) {
    if (foreground === this.state.foreground) return;
    this.update({ foreground });
    if (!foreground) {
      this.stopObservation();
      void this.persist().catch((error) => this.update({ error: message(error) }));
    } else if (this.client) {
      void this.reconnect().catch((error) => this.update({ error: message(error) }));
    }
  }
  dispose() {
    ++this.connectionAttempt;
    this.stopObservation();
    ++this.epoch;
    this.listeners.clear();
  }
}
