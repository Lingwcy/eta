import { Schema } from "effect";

export const sandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
export const SandboxModeSchema = Schema.Literals(sandboxModes);
export type SandboxMode = typeof SandboxModeSchema.Type;
export const defaultSandboxMode: SandboxMode = "workspace-write";

export const sandboxLabels = {
  "read-only": "只读",
  "workspace-write": "工作区沙盒",
  "danger-full-access": "完全访问",
} satisfies Record<SandboxMode, string>;

export interface SandboxPolicy {
  readonly mode: SandboxMode;
  readonly workspaceRoot: string;
  readonly readableRoots?: readonly string[];
  readonly writableRoots?: readonly string[];
  readonly deniedRoots?: readonly string[];
  readonly networkAccess?: boolean;
  readonly commandAccess?: boolean;
  readonly scratchRoot?: string;
}

export interface SandboxStatus {
  allowedModes?: readonly SandboxMode[];
  readonly mode: SandboxMode;
  readonly backend: "seatbelt" | "bubblewrap" | "landlock" | "none" | "unavailable";
  readonly available: boolean;
  readonly reason?: string;
}

export interface SandboxApproval {
  readonly id: string;
  readonly toolTaskId: string;
  readonly conversationId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly reason: string;
  readonly mode: SandboxMode;
  readonly revision: number;
  readonly networkAccess: boolean;
  readonly readableRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly status: "pending" | "approved" | "denied" | "cancelled" | "consumed";
}
