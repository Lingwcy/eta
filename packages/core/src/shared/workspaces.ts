export interface WorkspaceMetadata {
  readonly id: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly kind: "project-root" | "worktree";
  readonly createdAt: number;
}
