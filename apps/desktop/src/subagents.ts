import type {
  SubagentSettingsSchema,
  SubagentCommandSchema,
} from "./main/service/subagents/schema.ts";

export type SubagentSettings = typeof SubagentSettingsSchema.Type;
export const defaultSubagentSettings: SubagentSettings = {
  enabled: true,
  mode: "opportunistic",
  maxDepth: 3,
  maxConcurrent: 4,
  presets: [],
};
export type SubagentCommand = typeof SubagentCommandSchema.Type;
export interface SubagentSummary {
  path: string;
  parent: string;
  conversationId: number;
  fork: boolean;
  depth: number;
  status: "running" | "queued" | "paused" | "completed" | "failed" | "stopped";
  model?: { provider: string; modelId: string };
  error?: string;
  canDelegate?: boolean;
  progress?: { message: string; timestamp: number };
  output?: string;
  outputTruncated?: boolean;
}
