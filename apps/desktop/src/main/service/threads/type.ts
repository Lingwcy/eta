import type { SessionRef } from "../sessions/type";

export interface ThreadMetadata {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionRef: SessionRef;
  readonly archivedAt?: number;
  readonly title: string;
  readonly createdAt: number;
}
