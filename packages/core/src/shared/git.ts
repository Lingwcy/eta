export type GitHead =
  | { readonly kind: "branch"; readonly name: string; readonly sha: string }
  | { readonly kind: "unborn"; readonly name: string }
  | { readonly kind: "detached"; readonly sha: string };

export interface GitRemote {
  readonly name: string;
  /** Fetch URL without credentials. */
  readonly url: string;
  readonly github?: { readonly host: string; readonly owner: string; readonly repo: string };
}

export interface GitChanges {
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly conflicted: number;
}

/** The GitHub repository a project browses; `reason` says why this remote won. */
export interface GitHubSelection {
  readonly remote: string;
  readonly owner: string;
  readonly repo: string;
  readonly reason: "saved" | "origin" | "only";
}

export type GitRepositoryInfo =
  | {
      readonly status: "ready";
      readonly workspaceId: string;
      readonly root: string;
      readonly gitDir: string;
      readonly commonDir: string;
      /** Workspace path relative to the repository root; empty at the root. */
      readonly prefix: string;
      readonly linkedWorktree: boolean;
      readonly head: GitHead;
      readonly remotes: readonly GitRemote[];
      readonly changes: GitChanges;
      readonly operation?: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";
      /** Present when any remote is on GitHub; `undefined` selection means the user must choose. */
      readonly github?: {
        readonly selection?: GitHubSelection;
        readonly savedInvalid?: boolean;
        readonly candidates: readonly string[];
      };
    }
  | { readonly status: "not-repository"; readonly workspaceId: string }
  | {
      readonly status: "unavailable";
      readonly workspaceId: string;
      readonly reason: "git-missing" | "directory-missing" | "error";
      readonly message: string;
    };

export interface GitBranch {
  readonly name: string;
  readonly kind: "local" | "remote";
  readonly sha: string;
  readonly upstream?: string;
  readonly current: boolean;
  /** Worktree that has this branch checked out, when it is not the queried workspace. */
  readonly checkedOutAt?: string;
}
