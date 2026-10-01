import type { CatalogState } from "./type.ts";

export interface CatalogViolation {
  readonly code:
    | "DuplicateId"
    | "ProjectNotFound"
    | "WorkspaceNotFound"
    | "WorkspaceRootMismatch"
    | "SessionWorkspaceMismatch"
    | "DuplicateSessionBinding";
  readonly message: string;
}

/**
 * 检查整改 state 是否满足预期的关系模式
 * @param state
 * @returns
 */
export function validateCatalog(state: CatalogState): ReadonlyArray<CatalogViolation> {
  const violations: CatalogViolation[] = [];
  const projects = indexById("Project", state.projects, violations);
  const workspaces = indexById("Workspace", state.workspaces, violations);
  indexById("Thread", state.threads, violations);

  for (const workspace of state.workspaces) {
    const project = projects.get(workspace.projectId);
    if (!project) {
      violations.push({
        code: "ProjectNotFound",
        message: `Workspace ${workspace.id} 里面的 project id: ${workspace.projectId} 根本找不到.`,
      });
    } else if (workspace.kind === "project-root" && workspace.cwd !== project.rootPath) {
      violations.push({
        code: "WorkspaceRootMismatch",
        message: `Workspace ${workspace.id} cwd ${workspace.cwd} differs from project ${project.id} root ${project.rootPath}.`,
      });
    }
  }

  const bindings = new Map<string, Map<string, string>>();
  for (const thread of state.threads) {
    const workspace = workspaces.get(thread.workspaceId);
    const session = thread.sessionRef.metadata;
    if (!workspace) {
      violations.push({
        code: "WorkspaceNotFound",
        message: `Thread ${thread.id} references missing workspace ${thread.workspaceId}.`,
      });
    } else if (session.cwd !== workspace.cwd) {
      violations.push({
        code: "SessionWorkspaceMismatch",
        message: `Thread ${thread.id} session ${session.id} cwd ${session.cwd} differs from workspace ${workspace.id} cwd ${workspace.cwd}.`,
      });
    }

    let sessions = bindings.get(session.cwd);
    if (!sessions) {
      sessions = new Map();
      bindings.set(session.cwd, sessions);
    }
    const owner = sessions.get(session.id);
    if (owner !== undefined) {
      violations.push({
        code: "DuplicateSessionBinding",
        message: `Threads ${owner} and ${thread.id} bind the same session ${session.id} in ${session.cwd}.`,
      });
    } else {
      sessions.set(session.id, thread.id);
    }
  }

  return violations;
}

function indexById<T extends { readonly id: string }>(
  kind: string,
  records: ReadonlyArray<T>,
  violations: CatalogViolation[],
) {
  const index = new Map<string, T>();
  for (const record of records) {
    if (index.has(record.id)) {
      violations.push({ code: "DuplicateId", message: `${kind} ID ${record.id} 重复了.` });
    } else {
      index.set(record.id, record);
    }
  }
  return index;
}
