import type { ProjectMetadata } from "./projects.ts";
import type { WorkspaceMetadata } from "./workspaces.ts";
import type { ThreadMetadata } from "./threads.ts";

export interface CatalogState {
  readonly projects: ReadonlyArray<ProjectMetadata>;
  readonly workspaces: ReadonlyArray<WorkspaceMetadata>;
  readonly threads: ReadonlyArray<ThreadMetadata>;
}
