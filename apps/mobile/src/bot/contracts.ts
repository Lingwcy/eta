import { z } from "zod";

// These schemas describe the consumed /v1 JSON fields, not the Bot's runtime objects.
export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const SandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
export const ConnectionSchema = z.object({ url: z.string(), token: z.string().min(1) });
export type Connection = z.infer<typeof ConnectionSchema>;
export const ModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  thinkingLevels: z.array(ThinkingLevelSchema),
});
export type BotModel = z.infer<typeof ModelSchema>;
export const ConfigurationSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  thinkingLevel: ThinkingLevelSchema,
  sandboxMode: SandboxModeSchema.optional(),
});
export type Configuration = z.infer<typeof ConfigurationSchema>;
export const ProjectSchema = z.object({ id: z.string(), name: z.string(), rootPath: z.string() });
export const WorkspaceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.string(),
});
export const ThreadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable().optional(),
  title: z.string(),
  createdAt: z.number(),
  archivedAt: z.number().optional(),
});
export type BotThread = z.infer<typeof ThreadSchema>;
export const LibrarySchema = z.object({
  projects: z.array(ProjectSchema),
  workspaces: z.array(WorkspaceSchema),
  threads: z.array(ThreadSchema),
  models: z.array(ModelSchema),
  allowedSandboxModes: z.array(SandboxModeSchema).optional(),
  settings: z.object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultThinkingLevel: ThinkingLevelSchema,
    defaultSandboxMode: SandboxModeSchema.optional(),
  }),
});
export type BotLibrary = z.infer<typeof LibrarySchema>;
const ContentSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  data: z.string().optional(),
  mimeType: z.string().optional(),
});
export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "toolResult"]),
  content: z.union([z.string(), z.array(ContentSchema)]),
  timestamp: z.number().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type BotMessage = z.infer<typeof MessageSchema>;
export const ApprovalSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  reason: z.string(),
  status: z.enum(["pending", "approved", "denied", "cancelled", "consumed"]),
  networkAccess: z.boolean(),
  readableRoots: z.array(z.string()),
  writableRoots: z.array(z.string()),
  reusable: z.boolean().optional(),
  gitMetadata: z
    .object({ commonDir: z.string(), worktreeDir: z.string(), branch: z.string().optional() })
    .optional(),
  review: z
    .object({
      status: z.string(),
      risk: z.string().optional(),
      rationale: z.string().optional(),
      skippedReason: z.string().optional(),
    })
    .optional(),
});
export const SnapshotSchema = z.object({
  configuration: z.object({
    model: z.object({ provider: z.string(), modelId: z.string() }),
    thinkingLevel: ThinkingLevelSchema,
  }),
  transcript: z.array(
    z.object({ id: z.string(), message: MessageSchema, toolStatus: z.string().optional() }),
  ),
  operation: z
    .object({
      id: z.string(),
      status: z.enum(["running", "aborting"]),
      streamingMessage: MessageSchema.optional(),
      runningTools: z.array(
        z.object({
          toolCallId: z.string(),
          toolName: z.string(),
          status: z.string(),
          args: z.record(z.string(), z.unknown()),
          isError: z.boolean().optional(),
        }),
      ),
      waitingForApproval: z.boolean().optional(),
      waitingForSubagents: z.boolean().optional(),
      retry: z.object({ attempt: z.number(), maxAttempts: z.number() }).optional(),
      deferred: z.object({ pollAt: z.number() }).optional(),
    })
    .nullable(),
  lastResult: z
    .object({
      operationId: z.string(),
      status: z.enum(["completed", "failed", "aborted"]),
      error: z.object({ message: z.string() }).optional(),
    })
    .nullable(),
  approvals: z.array(ApprovalSchema).optional(),
  sandbox: z
    .object({
      mode: SandboxModeSchema,
      available: z.boolean(),
      reason: z.string().optional(),
      allowedModes: z.array(SandboxModeSchema).optional(),
    })
    .optional(),
  faulted: z.boolean(),
  recoveryRequired: z.boolean().optional(),
  blockedReason: z.string().optional(),
  compacting: z.boolean().optional(),
});
export type BotSnapshot = z.infer<typeof SnapshotSchema>;
export const SnapshotResponseSchema = z.object({
  snapshot: SnapshotSchema,
  contextTokens: z.number(),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
export const OpenThreadSchema = SnapshotResponseSchema.extend({
  id: z.string(),
  model: ModelSchema,
  thread: ThreadSchema,
});
export type OpenThread = z.infer<typeof OpenThreadSchema>;
export const AdmissionSchema = z.object({
  operationId: z.string(),
  kind: z.literal("run"),
  startedAt: z.number(),
});
export const OperationSchema = AdmissionSchema.extend({
  status: z.enum(["queued", "running", "paused", "completed", "failed", "aborted"]),
  messages: z.array(MessageSchema),
  error: z.string().optional(),
});
export const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
