import type { ProjectMetadata } from "../projects/type";
import type { WorkspaceMetadata } from "../workspaces/type";
import type { ThreadMetadata } from "../threads/type";

export interface CatalogState {
  readonly projects: ReadonlyArray<ProjectMetadata>;
  readonly workspaces: ReadonlyArray<WorkspaceMetadata>;
  readonly threads: ReadonlyArray<ThreadMetadata>;
}
