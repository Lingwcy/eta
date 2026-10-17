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
import type { SandboxApproval, SandboxMode, SandboxStatus } from "../shared/sandbox.ts";
import type { AgentMode } from "../shared/runtime-settings.ts";

export type ThinkingLevel = ModelThinkingLevel | "off";

export interface CreateThreadConfiguration {
  sandboxMode?: SandboxMode;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export type AgentModel = Pick<Model<Api>, "id" | "provider" | "name" | "contextWindow"> &
  Partial<Pick<Model<Api>, "input" | "inputLimits">> & {
    readonly thinkingLevels: readonly ThinkingLevel[];
  };

/** Application transport contract, independent of the provider's runtime handles. */
export interface OperationAdmission {
  operationId: string;
  kind: "run";
  startedAt: number;
  /** Stable user-message identity in the observed transcript, derived from the durable receipt. */
  inputEntryId?: string;
}

export interface OperationResult extends OperationAdmission {
  /** Original input owning an autonomous subagent follow-up, when durable records prove its lineage. */
  originOperationId?: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "aborted";
  messages: readonly Message[];
  endedAt?: number;
  error?: string;
}

export interface RecoveryState {
  required: boolean;
  pending: boolean;
  /** Only queued submissions remain; no foreground task or placed input is executing them. */
  queuedOnly: boolean;
  unsafeTool: boolean;
  blockedTasks: readonly { taskId: string; kind: string; reason: string }[];
}

export interface SnapshotTool {
  status: "generating" | "pending" | "running" | "waiting" | "settled" | "stopped" | "incomplete";
  description?: string;
  toolCallId: string;
  taskId?: string;
  parentToolCallId?: string;
  parentTaskId?: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: { content: ToolResultMessage["content"]; details?: unknown };
  isError?: boolean;
}

export interface AgentSnapshot {
  /** Display summaries resolved against each call's admitted tool declaration. */
  toolIntents?: Record<string, string>;
  sandbox?: SandboxStatus;
  approvals?: readonly SandboxApproval[];
  /** Recent automatic and reused approvals, oldest first. */
  approvalHistory?: readonly SandboxApproval[];
  subagents?: readonly SubagentSummary[];
  activeSkills?: readonly ActiveSkill[];
  configuration: {
    model: { provider: string; modelId: string };
    thinkingLevel: ThinkingLevel;
    agentMode?: AgentMode;
  };
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
        waitingForApproval?: boolean;
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
