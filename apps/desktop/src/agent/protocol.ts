import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ThinkingLevel as ModelThinkingLevel,
  ToolResultMessage,
} from "@earendil-works/pi-ai";

export type ThinkingLevel = ModelThinkingLevel | "off";

export type AgentModel = Pick<Model<Api>, "id" | "provider" | "name" | "contextWindow"> &
  Partial<Pick<Model<Api>, "input" | "inputLimits">>;

/** Desktop's transport contract, independent of the provider's runtime handles. */
export interface OperationAdmission {
  operationId: string;
  kind: "run";
  startedAt: number;
}

export interface SnapshotTool {
  status: "running" | "settled";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: { content: ToolResultMessage["content"]; details?: unknown };
  isError?: boolean;
}

export interface AgentSnapshot {
  configuration: { model: { provider: string; modelId: string }; thinkingLevel: ThinkingLevel };
  transcript: { id: string; type: "message"; message: Message }[];
  operation:
    | (Omit<OperationAdmission, "operationId"> & {
        id: string;
        status: "running" | "aborting";
        fromTipId: null;
        runningTools: SnapshotTool[];
        streamingMessage?: AssistantMessage;
        retry?: { attempt: number; maxAttempts: number };
        deferred?: { pollAt: number };
      })
    | null;
  lastResult:
    | (OperationAdmission & {
        status: "completed" | "failed" | "aborted";
        fromTipId: null;
        tipId: null;
        endedAt: number;
        error?: { message: string };
      })
    | null;
  faulted: boolean;
  /** Opening history never resumes unfinished work implicitly. */
  recoveryRequired?: boolean;
  blockedReason?: string;
  compacting?: boolean;
}

export interface SnapshotResponse {
  snapshot: AgentSnapshot;
  contextTokens: number;
}

export interface SessionResponse extends SnapshotResponse {
  id: string;
  model: AgentModel;
}
