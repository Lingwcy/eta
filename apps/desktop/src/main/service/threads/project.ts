import type { CatalogState } from "../catalog/type.ts";
import type { ThreadMetadata } from "./type.ts";

/** Sidebar ownership is independent of the immutable execution workspace. */
export function threadProjectId(thread: ThreadMetadata, catalog: Pick<CatalogState, "workspaces">) {
  return thread.projectId !== undefined
    ? thread.projectId
    : (catalog.workspaces.find((workspace) => workspace.id === thread.workspaceId)?.projectId ??
        null);
}
