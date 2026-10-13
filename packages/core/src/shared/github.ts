export type GitHubKind = "pulls" | "issues";
export type GitHubState = "open" | "closed" | "all";
export interface GitHubQuery {
  readonly projectId: string;
  readonly kind: GitHubKind;
  readonly state: GitHubState;
  readonly cursor?: string;
  readonly refresh?: boolean;
}
export interface GitHubIdentity {
  /** Opaque host session ID for cache isolation; never exposes credentials. */
  readonly revision?: string;
  readonly authenticated: boolean;
  readonly login?: string;
  readonly source: "gh" | "anonymous";
}
export interface GitHubItem {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly draft: boolean;
  readonly author: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly head?: string;
  readonly base?: string;
  readonly labels: readonly string[];
}
export interface GitHubRepositoryContext {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly commonDir: string;
  readonly remote: string;
  readonly owner: string;
  readonly repo: string;
}
export type GitHubPage =
  | {
      readonly status: "ready";
      readonly repository: GitHubRepositoryContext;
      readonly identity: GitHubIdentity;
      readonly items: readonly GitHubItem[];
      readonly nextCursor?: string;
      readonly fetchedAt: number;
      readonly stale: boolean;
    }
  | {
      readonly status: "error";
      readonly code:
        | "selection-required"
        | "not-github"
        | "unavailable"
        | "unauthenticated"
        | "access-denied"
        | "rate-limit"
        | "network";
      readonly message: string;
      readonly retryAt?: number;
      readonly repository?: GitHubRepositoryContext;
      readonly identity?: GitHubIdentity;
      readonly cached?: Extract<GitHubPage, { status: "ready" }>;
    };
