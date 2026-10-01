import type { JsonlSessionMetadata } from "@eta/agent";

export type SessionRef = EtaSessionMetadata;

export interface EtaSessionMetadata {
  readonly backendId: "eta";
  readonly metadata: JsonlSessionMetadata;
}
