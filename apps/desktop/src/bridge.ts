import type { ImageAttachment, ImageSource } from "./images/types.ts";
import type { AuthProvider, LoginMethod, LoginState } from "./authentication.ts";
import type { OperationAdmission } from "./agent/protocol.ts";
import type { SessionResponse, SnapshotResponse } from "./agent/protocol.ts";
import type { AgentModel, ThinkingLevel } from "./agent/protocol.ts";
import type { DesktopSettings } from "./main/service/settings/index.ts";
import type { ProjectMetadata } from "./main/service/projects/type.ts";
import type { WorkspaceMetadata } from "./main/service/workspaces/type.ts";
import type { ThreadMetadata } from "./main/service/threads/type.ts";
import type { BrowserCommand, BrowserEvent, BrowserState } from "./browser/protocol.ts";
import type { StorageReport, StorageTarget } from "./main/storage/types.ts";

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
  configureThread(
    id: string,
    provider: string,
    modelId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<SessionResponse>;
  submit(
    sessionId: string,
    prompt: string,
    images?: readonly ImageAttachment[],
  ): Promise<OperationAdmission>;
  stop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

export interface DesktopLibrary {
  projects: ReadonlyArray<ProjectMetadata>;
  workspaces: ReadonlyArray<WorkspaceMetadata>;
  threads: ReadonlyArray<ThreadMetadata>;
  settings: DesktopSettings;
  models: ReadonlyArray<AgentModel>;
  providers: ReadonlyArray<AuthProvider>;
  credentials: ReadonlyArray<{ providerId: string; type: "api_key" | "oauth" }>;
}

export interface DesktopBridge extends AgentBridge {
  subscribeLibrary(listener: () => void): () => void;
  openThreadWindow(id: string): Promise<void>;
  openThreadFile(id: string, mode: "default" | "reveal" | "choose"): Promise<void>;
  moveThread(id: string, projectId: string | null): Promise<ThreadMetadata>;
  deleteThread(id: string): Promise<void>;
  storage(): Promise<StorageReport>;
  revealStorage(target: StorageTarget): Promise<void>;
  browser(command: BrowserCommand): Promise<BrowserState | null>;
  subscribeBrowser(listener: (event: BrowserEvent) => void): () => void;
  library(): Promise<DesktopLibrary>;
  prepareImage(
    source: ImageSource,
    cwd?: string,
    provider?: string,
    modelId?: string,
  ): Promise<ImageAttachment>;
  chooseProject(): Promise<ProjectMetadata | null>;
  chooseDirectory(): Promise<string | null>;
  registerProject(rootPath: string, name: string): Promise<ProjectMetadata>;
  createThread(workspaceId: string, requestId: string): Promise<SessionResponse>;
  renameThread(id: string, title: string): Promise<ThreadMetadata>;
  archiveThread(id: string, archived: boolean): Promise<ThreadMetadata>;
  resume(id: string): Promise<void>;
  compact(id: string): Promise<void>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  startLogin(provider: string, method: LoginMethod): Promise<LoginState>;
  loginState(id: string): Promise<LoginState>;
  answerLogin(id: string, promptId: string, value: string): Promise<void>;
  cancelLogin(id: string): Promise<void>;
  openLoginLink(id: string, url: string): Promise<void>;
  removeCredential(provider: string, method: LoginMethod): Promise<void>;
}

declare global {
  interface Window {
    eta: DesktopBridge;
  }
}
