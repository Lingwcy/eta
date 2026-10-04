import type { ImageAttachment } from "../../../src/images/types.ts";
import type { OperationAdmission } from "../../../src/agent/protocol.ts";
import type {
  SessionResponse,
  SnapshotResponse,
  ThinkingLevel,
} from "../../../src/agent/protocol.ts";
import type { AgentBridge } from "../../../src/bridge.ts";

export interface AgentClientState {
  session: Pick<SessionResponse, "id" | "model"> | null;
  observation: SnapshotResponse | null;
  connection: "connecting" | "connected" | "error";
  submitting: boolean;
  stopping: boolean;
  admission: OperationAdmission | null;
  error: string | null;
}

export const initialAgentState: AgentClientState = {
  session: null,
  observation: null,
  connection: "connecting",
  submitting: false,
  stopping: false,
  admission: null,
  error: null,
};

/** Disposing a view only unsubscribes; durable execution and history belong to main. */
export class ThreadAgentClient {
  private state = initialAgentState;
  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents?: () => void;
  private disposed = false;

  constructor(private readonly bridge: AgentBridge = window.eta) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async connect(threadId: string) {
    try {
      const session = await this.bridge.openThread(threadId);
      if (this.disposed) {
        return;
      }
      this.update({
        session: { id: session.id, model: session.model },
        observation: { snapshot: session.snapshot, contextTokens: session.contextTokens },
      });
      this.unsubscribeEvents = this.bridge.subscribe(session.id, (event) => {
        if (event.type === "snapshot") {
          this.observe(event.value);
        } else {
          this.update({ connection: "error", error: event.message });
        }
      });
      this.update({ connection: "connected" });
    } catch (error) {
      if (!this.disposed) this.update({ connection: "error", error: message(error) });
    }
  }

  async configure(provider: string, modelId: string, thinkingLevel: ThinkingLevel) {
    const sessionId = this.state.session?.id;
    if (!sessionId || this.disposed) throw new Error("会话尚未打开");
    const session = await this.bridge.configureThread(sessionId, provider, modelId, thinkingLevel);
    if (this.disposed || this.state.session?.id !== session.id) return;
    const observation = this.state.observation;
    // Configuration replies may arrive after a newer subscription snapshot. Keep its history and run state.
    this.update({
      session: { id: session.id, model: session.model },
      observation: observation
        ? {
            ...observation,
            snapshot: { ...observation.snapshot, configuration: session.snapshot.configuration },
          }
        : { snapshot: session.snapshot, contextTokens: session.contextTokens },
    });
  }

  async submit(prompt: string, images?: readonly ImageAttachment[]) {
    if (
      this.state.connection !== "connected" ||
      this.state.submitting ||
      this.state.observation?.snapshot.operation ||
      this.state.observation?.snapshot.compacting ||
      this.state.admission ||
      this.state.observation?.snapshot.recoveryRequired ||
      this.state.observation?.snapshot.blockedReason
    )
      throw new Error("Agent 尚未就绪");
    const sessionId = this.state.session?.id;
    if (!sessionId) throw new Error("会话尚未打开");
    this.update({ submitting: true, error: null });
    try {
      const admission = await this.bridge.submit(sessionId, prompt, ...(images ? [images] : []));
      const snapshot = this.state.observation?.snapshot;
      this.update({
        admission:
          snapshot?.operation?.id === admission.operationId ||
          snapshot?.lastResult?.operationId === admission.operationId
            ? null
            : admission,
      });
    } catch (error) {
      this.update({ error: message(error) });
      throw error;
    } finally {
      this.update({ submitting: false });
    }
  }

  async stop() {
    const sessionId = this.state.session?.id;
    if (!sessionId || this.state.stopping) return;
    this.update({ stopping: true, error: null });
    try {
      await this.bridge.stop(sessionId);
    } catch (error) {
      this.update({ error: message(error) });
    } finally {
      this.update({ stopping: false });
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEvents?.();
    this.listeners.clear();
  }

  private observe(observation: SnapshotResponse) {
    const id = this.state.admission?.operationId;
    const acknowledged =
      id &&
      (observation.snapshot.operation?.id === id ||
        observation.snapshot.lastResult?.operationId === id);
    this.update({
      observation,
      connection: "connected",
      error: null,
      ...(acknowledged ? { admission: null } : {}),
    });
  }

  private update(patch: Partial<AgentClientState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
