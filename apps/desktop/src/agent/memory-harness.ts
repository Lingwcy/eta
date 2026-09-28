import {
  AgentHarness,
  BACKGROUND_CONTEXT,
  buildContextEntries,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  estimateContextTokens,
  MemorySessionRepo,
  reduceLaneSnapshot,
  sessionEntryToContextMessages,
} from "@eta/agent";
import type {
  AgentLane,
  ExecutionToolContext,
  LaneSnapshot,
  Session,
  WatchHandle,
} from "@eta/agent";
import { NodeExecutionEnv } from "@eta/agent/env/nodejs";
import type { Models } from "@earendil-works/pi-ai";
import type { SessionResponse, SnapshotResponse, AgentModel } from "./protocol.ts";
import type { AgentSettings } from "./agent-settings.ts";

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

interface MemoryHarnessSession {
  session: Session;
  harness: AgentHarness<ExecutionToolContext>;
  lane: AgentLane;
  model: AgentModel;
  errors: Set<(message: string) => void>;
  watches: Set<WatchHandle<LaneSnapshot>>;
}

export class MemoryHarnessService {
  private readonly repo = new MemorySessionRepo();
  private readonly sessions = new Map<string, MemoryHarnessSession>();
  private closed = false;
  private readonly models: Models;
  private readonly cwd: string;
  private readonly readSettings: () => Promise<AgentSettings>;

  constructor(
    models: Models,
    cwd: string,
    readSettings: () => Promise<AgentSettings> = async () => ({}),
  ) {
    this.models = models;
    this.cwd = cwd;
    this.readSettings = readSettings;
  }

  async create(): Promise<SessionResponse> {
    if (this.closed) throw new AgentError("Agent 服务已关闭");
    const settings = await this.readSettings();
    await this.models.refresh();
    const model = (await this.models.getAvailable()).find(
      (candidate) =>
        (!settings.defaultProvider || candidate.provider === settings.defaultProvider) &&
        (!settings.defaultModel || candidate.id === settings.defaultModel),
    );
    if (!model && (settings.defaultProvider || settings.defaultModel))
      throw new AgentError(
        `配置的模型 ${settings.defaultProvider ?? "*"}/${settings.defaultModel ?? "*"} 不可用，请检查 ~/.pi/agent/settings.json 和 provider 认证信息。`,
      );
    if (!model) throw new AgentError("没有可用模型。请配置 provider 的认证信息后重试。");
    const session = await this.repo.create({}, BACKGROUND_CONTEXT);
    try {
      const { harness } = await AgentHarness.create<ExecutionToolContext>(
        {
          session,
          models: this.models,
          model,
          thinkingLevel: settings.defaultThinkingLevel,
          tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
          toolContext: { env: new NodeExecutionEnv({ cwd: this.cwd }) },
          systemPrompt: `You are Eta, a coding agent. Work in ${this.cwd}. Use the available tools when needed. Be concise and answer in the user's language.`,
        },
        BACKGROUND_CONTEXT,
      );
      const lane = await harness.lane("main", BACKGROUND_CONTEXT);
      const record: MemoryHarnessSession = {
        session,
        harness,
        lane,
        model: {
          id: model.id,
          provider: model.provider,
          name: model.name,
          contextWindow: model.contextWindow,
        },
        errors: new Set(),
        watches: new Set(),
      };
      if (this.closed) {
        await harness.close(BACKGROUND_CONTEXT);
        throw new AgentError("Agent 服务已关闭");
      }
      this.sessions.set(session.metadata.id, record);
      return {
        id: session.metadata.id,
        model: record.model,
        ...(await this.snapshot(session.metadata.id)),
      };
    } catch (error) {
      const record = this.sessions.get(session.metadata.id);
      this.sessions.delete(session.metadata.id);
      await record?.harness.close(BACKGROUND_CONTEXT);
      await session.close(BACKGROUND_CONTEXT);
      await this.repo.delete(session.metadata, BACKGROUND_CONTEXT);
      throw error;
    }
  }

  get(id: string): MemoryHarnessSession {
    const session = this.sessions.get(id);
    if (!session) throw new AgentError("内存会话已不存在，请新建会话。");
    return session;
  }

  async snapshot(id: string): Promise<SnapshotResponse> {
    const watch = await this.get(id).lane.watch(BACKGROUND_CONTEXT);
    try {
      return serializeSnapshot(watch.snapshot);
    } finally {
      watch.unsubscribe();
    }
  }

  async subscribe(
    id: string,
    onSnapshot: (value: SnapshotResponse) => void,
    onError: (message: string) => void,
  ) {
    const session = this.get(id);
    const watch = await session.lane.watch(BACKGROUND_CONTEXT);
    let snapshot = watch.snapshot;
    session.watches.add(watch);
    session.errors.add(onError);
    onSnapshot(serializeSnapshot(snapshot));
    watch.start(async (event) => {
      if (reduceLaneSnapshot(snapshot, event) === "rebase")
        snapshot = await watch.resnapshot(BACKGROUND_CONTEXT);
      // The following entry_added event replaces the stream atomically in the client.
      if (event.type === "message_end" || event.type === "turn_start" || event.type === "turn_end")
        return;
      onSnapshot(serializeSnapshot(snapshot));
    });
    return () => {
      watch.unsubscribe();
      session.watches.delete(watch);
      session.errors.delete(onError);
    };
  }

  async submit(id: string, prompt: string) {
    const session = this.get(id);
    const admission = await session.lane.accept({ kind: "prompt", prompt }, BACKGROUND_CONTEXT);
    if (!admission.ok) throw new AgentError(admission.error.message);
    void session.lane
      .drive(
        { operationId: admission.value.operationId, waitForRetry: true, pollDeferred: true },
        BACKGROUND_CONTEXT,
      )
      .then(
        (result) => {
          if (!result.ok) for (const listener of session.errors) listener(result.error.message);
        },
        (error: unknown) => {
          for (const listener of session.errors)
            listener(error instanceof Error ? error.message : String(error));
        },
      );
    return admission.value;
  }

  async stop(id: string) {
    const result = await this.get(id).lane.abort(BACKGROUND_CONTEXT);
    if (!result.ok && result.error._tag !== "NoActiveOperation")
      throw new AgentError(result.error.message);
  }

  async delete(id: string) {
    const record = this.sessions.get(id);
    if (!record) return;
    this.sessions.delete(id);
    for (const watch of record.watches) watch.unsubscribe();
    record.watches.clear();
    record.errors.clear();
    await record.harness.close(BACKGROUND_CONTEXT);
    await this.repo.delete(record.session.metadata, BACKGROUND_CONTEXT);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.delete(id)));
    await this.repo.close(BACKGROUND_CONTEXT);
  }
}

function serializeSnapshot(snapshot: LaneSnapshot): SnapshotResponse {
  const messages = buildContextEntries(snapshot.transcript).flatMap(sessionEntryToContextMessages);
  // The declared agent wire type is the JSON representation of the authoritative snapshot.
  return {
    snapshot: JSON.parse(JSON.stringify(snapshot)) as SnapshotResponse["snapshot"],
    contextTokens: estimateContextTokens(messages).tokens,
  };
}
