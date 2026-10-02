import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createRegistry, Harness, MemoryStorage } from "@eta/agent";
import type {
  Conversation,
  ConversationView,
  ConversationWatch,
  LiveState,
  Submission,
} from "@eta/agent";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { CodingTools } from "@eta/agent/tools";
import type {
  SessionResponse,
  SnapshotResponse,
  AgentModel,
  OperationAdmission,
} from "./protocol.ts";
import type { AgentSettings } from "./agent-settings.ts";

export class AgentError extends Error {}

interface MemoryHarnessSession {
  harness: Harness;
  conversation: Conversation;
  model: AgentModel;
  configuration: SnapshotResponse["snapshot"]["configuration"];
  submission?: { handle: Submission; admission: OperationAdmission };
  disposed: boolean;
  lastResult: SnapshotResponse["snapshot"]["lastResult"];
  errors: Set<(message: string) => void>;
  watches: Set<ConversationWatch>;
}

export class MemoryHarnessService {
  private readonly sessions = new Map<string, MemoryHarnessSession>();
  private closed = false;

  constructor(
    private readonly models: Models,
    private readonly cwd: string,
    private readonly readSettings: () => Promise<AgentSettings> = async () => ({}),
  ) {}

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
    const registry = createRegistry();
    registry.install(CodingTools);
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        models: this.models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.cwd }),
      },
      BACKGROUND_CONTEXT,
    );
    const id = randomUUID();
    try {
      const configuration = {
        model: { provider: model.provider, modelId: model.id },
        thinkingLevel: settings.defaultThinkingLevel ?? "off",
      };
      const conversation = await harness.root(BACKGROUND_CONTEXT, {
        agent: {
          ...configuration,
          thinkingLevel: configuration.thinkingLevel === "off" ? null : configuration.thinkingLevel,
          cwd: this.cwd,
          instructions: `You are Eta, a coding agent. Work in ${this.cwd}. Use the available tools when needed. Be concise and answer in the user's language.`,
        },
      });
      if (this.closed) throw new AgentError("Agent 服务已关闭");
      const record: MemoryHarnessSession = {
        harness,
        conversation,
        configuration,
        model: {
          id: model.id,
          provider: model.provider,
          name: model.name,
          contextWindow: model.contextWindow,
        },
        disposed: false,
        lastResult: null,
        errors: new Set(),
        watches: new Set(),
      };
      this.sessions.set(id, record);
      return { id, model: record.model, ...(await this.snapshot(id)) };
    } catch (error) {
      this.sessions.delete(id);
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  get(id: string): MemoryHarnessSession {
    const record = this.sessions.get(id);
    if (!record) throw new AgentError("内存会话已不存在，请新建会话。");
    return record;
  }

  async snapshot(id: string): Promise<SnapshotResponse> {
    const record = this.get(id);
    await refreshResult(record);
    const watch = await record.conversation.watch(BACKGROUND_CONTEXT);
    try {
      return serializeSnapshot(record, watch.value);
    } finally {
      await watch.stop();
    }
  }

  async subscribe(
    id: string,
    onSnapshot: (value: SnapshotResponse) => void,
    onError: (message: string) => void,
  ) {
    const record = this.get(id);
    const watch = await record.conversation.watch(BACKGROUND_CONTEXT);
    record.watches.add(watch);
    record.errors.add(onError);
    await refreshResult(record);
    onSnapshot(serializeSnapshot(record, watch.value));
    watch.start(async (view) => {
      await refreshResult(record);
      onSnapshot(serializeSnapshot(record, view));
    });
    return () => {
      void watch.stop();
      record.watches.delete(watch);
      record.errors.delete(onError);
    };
  }

  async submit(id: string, prompt: string): Promise<OperationAdmission> {
    const record = this.get(id);
    const startedAt = Date.now();
    const handle = await record.conversation.submit(
      { type: "input", content: prompt, whenBusy: "reject" },
      BACKGROUND_CONTEXT,
    );
    const admission: OperationAdmission = {
      operationId: String(handle.id),
      kind: "run",
      startedAt,
    };
    record.submission = { handle, admission };
    void handle
      .wait(BACKGROUND_CONTEXT)
      .then(() => refreshResult(record))
      .catch((error: unknown) => {
        if (record.disposed) return;
        for (const listener of record.errors)
          listener(error instanceof Error ? error.message : String(error));
      });
    return admission;
  }

  async stop(id: string) {
    const record = this.get(id);
    await record.conversation.abort(BACKGROUND_CONTEXT);
    await refreshResult(record);
  }

  async delete(id: string) {
    const record = this.sessions.get(id);
    if (!record) return;
    this.sessions.delete(id);
    record.disposed = true;
    await Promise.all([...record.watches].map((watch) => watch.stop()));
    record.watches.clear();
    record.errors.clear();
    await record.harness.close(BACKGROUND_CONTEXT);
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.delete(id)));
  }
}

/** Maps durable submission receipts to the desktop's run acknowledgement. */
async function refreshResult(record: MemoryHarnessSession) {
  const submission = record.submission;
  if (!submission || record.disposed) return;
  const settled = await submission.handle.status(BACKGROUND_CONTEXT).catch((error: unknown) => {
    if (!record.disposed) throw error;
    return undefined;
  });
  if (!settled || record.disposed) return;
  if (settled.status !== "done" && settled.status !== "unanswered") return;
  if (
    record.submission !== submission ||
    record.lastResult?.operationId === submission.admission.operationId
  )
    return;
  const failed = settled.status === "unanswered" && settled.reason !== "aborted";
  record.lastResult = {
    ...submission.admission,
    status: settled.status === "done" ? "completed" : failed ? "failed" : "aborted",
    fromTipId: null,
    tipId: null,
    endedAt: Date.now(),
    ...(failed
      ? {
          error: {
            message:
              typeof settled.detail === "string"
                ? settled.detail
                : JSON.stringify(settled.detail ?? settled.reason),
          },
        }
      : {}),
  };
}

/** Converts one committed conversation revision to the desktop's JSON transport. */
function serializeSnapshot(record: MemoryHarnessSession, view: ConversationView): SnapshotResponse {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const transcript = view.entries.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role !== "system")
      .map((message, index) => ({
        id: `${entry.id}:${index}`,
        type: "message" as const,
        message,
      })),
  );
  const snapshot: SnapshotResponse["snapshot"] = {
    configuration: record.configuration,
    transcript,
    operation: live.run
      ? {
          id: String(live.run.inputs[0]!),
          kind: "run",
          startedAt: record.submission?.admission.startedAt ?? Date.now(),
          status: "running",
          fromTipId: null,
          runningTools: (live.tools ?? [])
            .filter((tool) => tool.status !== "done")
            .map((tool) => {
              const call = transcript
                .flatMap(({ message }) => (message.role === "assistant" ? message.content : []))
                .find((part) => part.type === "toolCall" && part.id === tool.callId);
              return {
                status: "running",
                toolCallId: tool.callId,
                toolName: tool.name,
                args: call?.type === "toolCall" ? call.arguments : {},
                ...(tool.output !== undefined
                  ? {
                      result: {
                        content: [{ type: "text", text: tool.output }],
                        details: tool.details,
                      },
                    }
                  : {}),
              };
            }),
          ...(live.generation?.message ? { streamingMessage: live.generation.message } : {}),
          ...(live.generation?.retry
            ? { retry: { attempt: live.generation.attempt, maxAttempts: 4 } }
            : {}),
          ...(live.generation?.deferred ? { deferred: live.generation.deferred } : {}),
        }
      : null,
    lastResult: record.lastResult,
    faulted: false,
  };
  return {
    snapshot: JSON.parse(JSON.stringify(snapshot)) as SnapshotResponse["snapshot"],
    contextTokens: estimateContextTokens(view.entries.flatMap((entry) => entry.model ?? [])).tokens,
  };
}
