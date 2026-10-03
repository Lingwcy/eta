import type { OperationAdmission } from "./agent/protocol.ts";
import type { SessionResponse, SnapshotResponse } from "./agent/protocol.ts";
import type { AgentModel, ThinkingLevel } from "./agent/protocol.ts";
import type { DesktopSettings } from "./main/service/settings/index.ts";
import type { ProjectMetadata } from "./main/service/projects/type.ts";
import type { WorkspaceMetadata } from "./main/service/workspaces/type.ts";
import type { ThreadMetadata } from "./main/service/threads/type.ts";

export type AgentEvent =
  | { type: "snapshot"; value: SnapshotResponse }
  | { type: "error"; message: string };

export interface CommandErrorDto {
  code: string;
  message: string;
  retryable: boolean;
}
export type CommandReply<A> = { ok: true; value: A } | { ok: false; error: CommandErrorDto };

export interface AgentBridge {
  openThread(id: string): Promise<SessionResponse>;
  submit(sessionId: string, prompt: string): Promise<OperationAdmission>;
  stop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface DesktopLibrary {
  projects: ReadonlyArray<ProjectMetadata>;
  workspaces: ReadonlyArray<WorkspaceMetadata>;
  threads: ReadonlyArray<ThreadMetadata>;
  settings: DesktopSettings;
  models: ReadonlyArray<AgentModel>;
  credentials: ReadonlyArray<{ providerId: string; type: "api_key" | "oauth" }>;
}

export interface DesktopBridge extends AgentBridge {
  library(): Promise<DesktopLibrary>;
  chooseProject(): Promise<ProjectMetadata | null>;
  chooseDirectory(): Promise<string | null>;
  registerProject(rootPath: string, name: string): Promise<ProjectMetadata>;
  createThread(workspaceId: string, requestId: string): Promise<SessionResponse>;
  renameThread(id: string, title: string): Promise<ThreadMetadata>;
  archiveThread(id: string, archived: boolean): Promise<ThreadMetadata>;
  configureThread(
    id: string,
    provider: string,
    modelId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<SessionResponse>;
  resume(id: string): Promise<void>;
  compact(id: string): Promise<void>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  setApiKey(provider: string, key: string): Promise<void>;
  removeCredential(provider: string): Promise<void>;
}

declare global {
  interface Window {
    eta: DesktopBridge;
  }
}
