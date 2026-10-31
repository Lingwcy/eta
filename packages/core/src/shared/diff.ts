/** Read-only diff contracts shared by local and remote clients. */
export type WorkspaceDiffScope = "all" | "staged" | "unstaged";

export interface DiffFile {
  readonly id: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly kind:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "conflicted"
    | "type-changed"
    | "untracked"
    | "submodule";
  readonly staged: boolean;
  readonly unstaged: boolean;
}

export type WorkspaceChanges =
  | {
      readonly status: "ready";
      readonly workspaceId: string;
      readonly scope: WorkspaceDiffScope;
      readonly revision: string;
      readonly files: readonly DiffFile[];
      readonly truncated?: boolean;
    }
  | { readonly status: "not-repository"; readonly workspaceId: string };

export type DiffContent =
  | {
      readonly status: "ready";
      readonly path: string;
      readonly oldPath?: string;
      readonly patch: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "binary"
        | "too-large"
        | "conflicted"
        | "submodule"
        | "symlink"
        | "not-recorded"
        | "uncertain"
        | "stale"
        | "unsupported";
    };

export interface FileChangeReference {
  readonly id: string;
  readonly path: string;
  readonly status: "recorded" | "no-change" | "unavailable" | "too-large" | "uncertain";
}

export interface WorkspaceChangesInput {
  readonly workspaceId: string;
  readonly scope: WorkspaceDiffScope;
}

export interface WorkspaceFileDiffInput extends WorkspaceChangesInput {
  readonly entryId: string;
  readonly expectedRevision: string;
}

export interface FileChangeDiffInput {
  readonly threadId: string;
  readonly changeId: string;
}
