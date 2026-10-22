interface WorkspaceBase {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

export type WorkspaceMetadata = WorkspaceBase &
  (
    | { readonly kind: "project-root" | "worktree"; readonly projectId: string }
    | { readonly kind: "temporary"; readonly projectId: null; readonly requestId?: string }
  );
