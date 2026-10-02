/** Persisted catalog identity; retained across agent storage API changes. */
export interface JsonlSessionMetadata {
  id: string;
  createdAt: number;
  storageVersion: number;
  cwd: string;
  path: string;
  modifiedAt: number;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
}

export type SessionRef = EtaSessionMetadata;

export interface EtaSessionMetadata {
  readonly backendId: "eta";
  readonly metadata: JsonlSessionMetadata;
}
