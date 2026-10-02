import type { OperationAdmission } from "./agent/protocol.ts";
import type { SessionResponse, SnapshotResponse } from "./agent/protocol.ts";

export type AgentEvent =
  | { type: "snapshot"; value: SnapshotResponse }
  | { type: "error"; message: string };

export interface DesktopBridge {
  createSession(): Promise<SessionResponse>;
  submit(sessionId: string, prompt: string): Promise<OperationAdmission>;
  stop(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  subscribe(sessionId: string, listener: (event: AgentEvent) => void): () => void;
}

declare global {
  interface Window {
    eta: DesktopBridge;
  }
}
