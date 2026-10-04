import type { SessionRef } from "../sessions/type";

export interface ThreadMetadata {
  readonly requestId?: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId?: string | null;
  readonly sessionRef: SessionRef;
  readonly archivedAt?: number;
  readonly title: string;
  readonly createdAt: number;
}
