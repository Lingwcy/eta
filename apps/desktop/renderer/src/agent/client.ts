import { LocalizedError, describeError, type Message } from "@/i18n/messages";
import type { ImageAttachment } from "@eta/core/images/types";
import type { OperationAdmission } from "@eta/core/agent/protocol";
import type { SessionResponse, SnapshotResponse, ThinkingLevel } from "@eta/core/agent/protocol";
import type { AgentBridge } from "../../../src/bridge.ts";
import { DesktopCommandError, unwrapReply } from "../../../src/command-reply.ts";
import {
  admissionUncertain,
  submissionIdentity,
  type UncertainSubmission,
} from "../../../src/shared/message-request.ts";
import type { SandboxMode } from "@eta/core/shared/sandbox";

export interface AgentClientState {
  session: Pick<SessionResponse, "id" | "model"> | null;
  observation: SnapshotResponse | null;
  connection: "connecting" | "connected" | "error";
  submitting: boolean;
  stopping: boolean;
  admission: OperationAdmission | null;
  error: Message | null;
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
  private uncertainSubmission?: UncertainSubmission;
  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents?: () => void;
  private stopAdmissionWatch?: () => void;
  private disposed = false;
  private connection?: AbortController;

  constructor(private readonly bridge: AgentBridge = window.eta) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async connect(threadId: string) {
    if (this.disposed) return;
    this.connection?.abort();
    const connection = new AbortController();
    this.connection = connection;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    const current = () => !connection.signal.aborted && !this.disposed;
    this.update({ connection: "connecting", error: null });
    for (let attempt = 0; current(); attempt++) {
      let session: SessionResponse;
      try {
        session = this.bridge.openThreadReply
          ? unwrapReply(await this.bridge.openThreadReply(threadId))
          : await this.bridge.openThread(threadId);
      } catch (error) {
        if (!current()) return;
        if (error instanceof DesktopCommandError && error.retryable && attempt < 2) {
          await retryDelay(1000 * (attempt + 1), connection.signal);
          continue;
        }
        this.update({ connection: "error", error: message(error) });
        return;
      }
      if (!current()) return;
      this.update({
        session: { id: session.id, model: session.model },
        observation: { snapshot: session.snapshot, contextTokens: session.contextTokens },
        connection: "connected",
        error: null,
      });
      if (!current()) return;
      try {
        const unsubscribe = this.bridge.subscribe(session.id, (event) => {
          if (!current()) return;
          if (event.type === "snapshot") {
            this.observe(event.value);
          } else {
            this.update({ connection: "error", error: event.localization ?? event.message });
          }
        });
        if (current()) this.unsubscribeEvents = unsubscribe;
        else unsubscribe();
      } catch (error) {
        if (current()) this.update({ connection: "error", error: message(error) });
      }
      return;
    }
  }

  async configure(provider: string, modelId: string, thinkingLevel: ThinkingLevel) {
    const sessionId = this.state.session?.id;
    if (!sessionId || this.disposed) throw new LocalizedError("chat:client.theChatIsNotOpenYet");
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

  async configureSandbox(mode: SandboxMode) {
    const sessionId = this.state.session?.id;
    if (!sessionId || this.disposed) throw new LocalizedError("chat:client.theChatIsNotOpenYet");
    const session = await this.bridge.configureSandbox(sessionId, mode);
    if (this.disposed || this.state.session?.id !== session.id) return;
    const observation = this.state.observation;
    // A policy change keeps the live transcript and subscription, including updates received while saving.
    this.update({
      observation: observation
        ? {
            ...observation,
            snapshot: { ...observation.snapshot, sandbox: session.snapshot.sandbox },
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
      throw new LocalizedError("chat:client.theAgentIsNotReadyYet");
    const sessionId = this.state.session?.id;
    if (!sessionId) throw new LocalizedError("chat:client.theChatIsNotOpenYet");
    // A retried message keeps the identity its first attempt may already have committed.
    const requestId = submissionIdentity(this.uncertainSubmission, prompt, images);
    this.update({ submitting: true, error: null });
    try {
      const admission = await this.bridge.submit(sessionId, prompt, images, requestId);
      this.uncertainSubmission = undefined;
      const snapshot = this.state.observation?.snapshot;
      this.update({
        admission:
          snapshot?.operation?.id === admission.operationId ||
          snapshot?.lastResult?.operationId === admission.operationId
            ? null
            : admission,
      });
    } catch (error) {
      // Only an unknown outcome justifies reusing the identity on the next attempt.
      this.uncertainSubmission = admissionUncertain(error)
        ? { requestId, prompt, images }
        : undefined;
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
    this.connection?.abort();
    this.stopAdmissionWatch?.();
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
    const previousAdmission = this.state.admission;
    this.state = { ...this.state, ...patch };
    if (this.state.admission !== previousAdmission) this.watchAdmission();
    for (const listener of this.listeners) listener();
  }

  /** A later turn can replace lastResult before this view observes its own input's completion. */
  private watchAdmission() {
    this.stopAdmissionWatch?.();
    this.stopAdmissionWatch = undefined;
    const admission = this.state.admission;
    const sessionId = this.state.session?.id;
    if (!admission || !sessionId) return;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => clearTimeout(timer);
    this.stopAdmissionWatch = stop;
    const current = () =>
      !this.disposed && this.stopAdmissionWatch === stop && this.state.admission === admission;
    const check = async () => {
      try {
        const result = await this.bridge.operation(sessionId, admission.operationId);
        if (!current()) return;
        if (
          result.operationId === admission.operationId &&
          ["completed", "failed", "aborted"].includes(result.status)
        )
          this.update({ admission: null });
      } catch {
        // An unavailable receipt does not establish whether the admitted input has finished.
      }
      if (current()) timer = setTimeout(() => void check(), 2000);
    };
    // Ordinary live acknowledgements usually arrive before a fallback read is necessary.
    timer = setTimeout(() => void check(), 1000);
  }
}

function retryDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function message(error: unknown) {
  return describeError(error, String(error));
}
