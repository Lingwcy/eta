import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import type { WorkspaceMetadata } from "@eta/core/shared/workspaces";

export type ModelSelection = AgentSnapshot["configuration"]["model"];

export function defaultModel(library: Pick<DesktopLibrary, "models" | "settings">) {
  return (
    library.models.find(
      (model) =>
        model.provider === library.settings.defaultProvider &&
        model.id === library.settings.defaultModel,
    ) ?? library.models[0]
  );
}

export function projectRootWorkspace(
  workspaces: readonly WorkspaceMetadata[],
  projectId: string | null,
) {
  return workspaces.find(
    (workspace) => workspace.projectId === projectId && workspace.kind === "project-root",
  );
}
