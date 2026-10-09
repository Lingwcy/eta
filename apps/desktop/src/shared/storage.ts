export type StorageTarget =
  | { kind: "sessions" }
  | { kind: "configuration"; id: string }
  | { kind: "session"; id: string };

export interface StoredSession {
  id: string;
  path: string;
  title: string;
  project?: string;
  bytes: number | null;
}

export interface StorageReport {
  paths: { sessions: string; modelConfiguration: string; catalog: string };
  sessionBytes: number;
  sessions: StoredSession[];
  issues: string[];
}
