import type { SubagentSummary } from "../shared/subagents.ts";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ThinkingLevel as ModelThinkingLevel,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ActiveSkill } from "../skills/types.ts";

export type ThinkingLevel = ModelThinkingLevel | "off";

export type AgentModel = Pick<Model<Api>, "id" | "provider" | "name" | "contextWindow"> &
  Partial<Pick<Model<Api>, "input" | "inputLimits">> & {
    readonly thinkingLevels: readonly ThinkingLevel[];
  };

/** Application transport contract, independent of the provider's runtime handles. */
export interface OperationAdmission {
  operationId: string;
  kind: "run";
  startedAt: number;
}

export interface OperationResult extends OperationAdmission {
  status: "queued" | "running" | "paused" | "completed" | "failed" | "aborted";
  messages: readonly Message[];
  endedAt?: number;
  error?: string;
}

export interface RecoveryState {
  required: boolean;
  pending: boolean;
  unsafeTool: boolean;
  blockedTasks: readonly { taskId: string; kind: string; reason: string }[];
}

export interface SnapshotTool {
  status: "running" | "settled" | "stopped" | "incomplete";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: { content: ToolResultMessage["content"]; details?: unknown };
  isError?: boolean;
}

export interface AgentSnapshot {
  subagents?: readonly SubagentSummary[];
  activeSkills?: readonly ActiveSkill[];
  configuration: { model: { provider: string; modelId: string }; thinkingLevel: ThinkingLevel };
  transcript: { id: string; type: "message"; message: Message; toolStatus?: "stopped" }[];
  operation:
    | (Omit<OperationAdmission, "operationId"> & {
        id: string;
        status: "running" | "aborting";
        fromTipId: null;
        runningTools: SnapshotTool[];
        streamingMessage?: AssistantMessage;
        retry?: { attempt: number; maxAttempts: number };
        deferred?: { pollAt: number };
        waitingForSubagents?: boolean;
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
