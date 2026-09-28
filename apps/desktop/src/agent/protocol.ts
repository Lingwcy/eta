import type { AgentLane, LaneTranscriptSnapshot, SessionMetadata } from "@eta/agent";

export type AgentModel = Pick<
  NonNullable<Awaited<ReturnType<AgentLane["getModel"]>>>,
  "id" | "provider" | "name" | "contextWindow"
>;

export interface SnapshotResponse {
  snapshot: LaneTranscriptSnapshot;
  contextTokens: number;
}

export interface SessionResponse extends SnapshotResponse {
  id: SessionMetadata["id"];
  model: AgentModel;
}
