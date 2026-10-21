import { access, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  GitUnavailableError,
  parseGitHubRemote,
  redactRemoteUrl,
  runGit,
} from "../../platform/git.ts";
import type {
  GitBranch,
  GitChanges,
  GitHead,
  GitHubSelection,
  GitRemote,
  GitRepositoryInfo,
} from "../../shared/git.ts";
import { CoreError } from "../errors.ts";
import { WorkspaceService } from "../workspaces/index.ts";
import { GitStoreService } from "./store.ts";

type Ready = Extract<GitRepositoryInfo, { status: "ready" }>;

/** Saved choice first, then `origin`, then the only GitHub remote; otherwise the user chooses. */
export function selectGitHub(remotes: readonly GitRemote[], saved: string | undefined) {
  const candidates = remotes.filter((remote) => remote.github);
  if (!candidates.length) return undefined;
  const pick = (
    remote: GitRemote | undefined,
    reason: GitHubSelection["reason"],
  ): GitHubSelection | undefined =>
    remote?.github
      ? { remote: remote.name, owner: remote.github.owner, repo: remote.github.repo, reason }
      : undefined;
  const savedRemote = saved ? candidates.find((remote) => remote.name === saved) : undefined;
  const selection =
    pick(savedRemote, "saved") ??
    pick(
      candidates.find((remote) => remote.name === "origin"),
      "origin",
    ) ??
    (candidates.length === 1 ? pick(candidates[0], "only") : undefined);
  return {
    candidates: candidates.map((remote) => remote.name),
    ...(selection ? { selection } : {}),
    ...(saved && !savedRemote ? { savedInvalid: true } : {}),
  };
}

export function parseRemotes(output: string): GitRemote[] {
  const remotes = new Map<string, GitRemote>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\t(\S+) \(fetch\)$/.exec(line);
    if (!match) continue;
    const [, name, url] = match;
    if (!name || !url || remotes.has(name)) continue;
    const github = parseGitHubRemote(url);
    remotes.set(name, { name, url: redactRemoteUrl(url), ...(github ? { github } : {}) });
  }
  return [...remotes.values()];
}

/** Counts from `git status --porcelain=v1 -z`. */
export function parseStatus(output: string): GitChanges {
  const changes = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const entries = output.split("\0");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 3) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    // Renames and copies carry the original path as the next NUL-separated field.
    if (x === "R" || x === "C") index++;
    if (x === "?" && y === "?") changes.untracked++;
    else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D"))
      changes.conflicted++;
    else {
      if (x !== " " && x !== "!") changes.staged++;
      if (y !== " " && y !== "!") changes.unstaged++;
    }
  }
  return changes;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function operation(gitDir: string): Promise<Ready["operation"]> {
  if (await exists(join(gitDir, "MERGE_HEAD"))) return "merge";
  if ((await exists(join(gitDir, "rebase-merge"))) || (await exists(join(gitDir, "rebase-apply"))))
    return "rebase";
  if (await exists(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (await exists(join(gitDir, "REVERT_HEAD"))) return "revert";
  if (await exists(join(gitDir, "BISECT_LOG"))) return "bisect";
  return undefined;
}

/** Live repository state for a directory; nothing here is cached or trusted from earlier reads. */
export async function inspectRepository(
  cwd: string,
  workspaceId: string,
  savedRemote?: string,
): Promise<GitRepositoryInfo> {
  if (
    !(await stat(cwd).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  )
    return {
      status: "unavailable",
      workspaceId,
      reason: "directory-missing",
      message: "工作区目录不存在",
    };
  try {
    const locationFlags = [
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
      "--show-prefix",
    ];
    const located = await runGit(cwd, ["rev-parse", ...locationFlags]);
    if (located.exitCode !== 0) {
      if (/not a git repository/i.test(located.stderr))
        return { status: "not-repository", workspaceId };
      return {
        status: "unavailable",
        workspaceId,
        reason: "error",
        message: located.stderr.trim().split("\n")[0] || "无法读取 Git 仓库",
      };
    }
    let locations = located.stdout.split("\n");
    if (locations.length !== locationFlags.length + 1) {
      // rev-parse has no NUL-delimited path format. Keep the single invocation for ordinary
      // paths, but query each value separately when embedded LF makes the output ambiguous.
      const results = await Promise.all(
        locationFlags.map((flag) => runGit(cwd, ["rev-parse", flag])),
      );
      locations = results.map((result) => {
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "无法定位 Git 仓库");
        // Remove only Git's terminator, not valid trailing whitespace in the pathname.
        return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
      });
    }
    const [top = "", gitDir = "", common = "", prefix = ""] = locations;
    const root = await realpath(top);
    const absoluteGitDir = await realpath(gitDir);
    const commonDir = await realpath(resolve(cwd, common));
    const symbolic = await runGit(cwd, ["symbolic-ref", "-q", "HEAD"]);
    const sha = (await runGit(cwd, ["rev-parse", "-q", "--verify", "HEAD"])).stdout.trim();
    const branch =
      symbolic.exitCode === 0 ? symbolic.stdout.trim().replace(/^refs\/heads\//, "") : "";
    const head: GitHead = branch
      ? sha
        ? { kind: "branch", name: branch, sha }
        : { kind: "unborn", name: branch }
      : { kind: "detached", sha };
    const remotes = parseRemotes((await runGit(cwd, ["remote", "-v"])).stdout);
    const changes = parseStatus(
      (await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])).stdout,
    );
    const github = selectGitHub(remotes, savedRemote);
    const current = await operation(absoluteGitDir);
    return {
      status: "ready",
      workspaceId,
      root,
      gitDir: absoluteGitDir,
      commonDir,
      prefix: prefix.replace(/\/$/, ""),
      linkedWorktree: absoluteGitDir !== commonDir,
      head,
      remotes,
      changes,
      ...(current ? { operation: current } : {}),
      ...(github ? { github } : {}),
    };
  } catch (error) {
    if (error instanceof GitUnavailableError)
      return { status: "unavailable", workspaceId, reason: "git-missing", message: error.message };
    return {
      status: "unavailable",
      workspaceId,
      reason: "error",
      message: error instanceof Error ? error.message : "无法读取 Git 仓库",
    };
  }
}

/** Worktree paths may contain LF; terminate records with NUL + Git's final LF. */
export const BRANCH_FORMAT =
  "--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(worktreepath)%00%(HEAD)%00";

export function parseBranches(output: string, workspaceRoot: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of output.split("\0\n")) {
    const [ref = "", sha = "", upstream = "", worktree = "", head = ""] = line.split("\0");
    if (!ref || ref.endsWith("/HEAD")) continue;
    const local = ref.startsWith("refs/heads/");
    const current = head === "*";
    branches.push({
      name: ref.replace(/^refs\/(heads|remotes)\//, ""),
      kind: local ? "local" : "remote",
      sha,
      current,
      ...(upstream ? { upstream } : {}),
      ...(worktree && !current && worktree !== workspaceRoot ? { checkedOutAt: worktree } : {}),
    });
  }
  return branches;
}

export class GitRepositoryService extends Context.Service<
  GitRepositoryService,
  {
    repository(workspaceId: string): Effect.Effect<GitRepositoryInfo, CoreError>;
    branches(workspaceId: string): Effect.Effect<readonly GitBranch[], CoreError>;
    selectGitHubRemote(
      projectId: string,
      remoteName: string | null,
      requestId?: string,
    ): Effect.Effect<GitRepositoryInfo, CoreError>;
  }
>()("eta/core/service/git/GitRepositoryService") {
  static readonly layer = Layer.effect(
    GitRepositoryService,
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceService;
      const store = yield* GitStoreService;
      const repository = Effect.fn("GitRepositoryService.repository")(function* (
        workspaceId: string,
      ) {
        const workspace = yield* workspaces.get(workspaceId);
        const saved = (yield* store.read).projects[workspace.projectId];
        let info = yield* Effect.promise(() =>
          inspectRepository(workspace.cwd, workspace.id, saved?.githubRemote),
        );
        const root = (yield* workspaces.list(workspace.projectId)).find(
          (value) => value.kind === "project-root",
        );
        if (info.status === "ready" && root) {
          if (workspace.id !== root.id) {
            const owner = yield* Effect.promise(() => inspectRepository(root.cwd, root.id));
            if (owner.status !== "ready" || owner.commonDir !== info.commonDir)
              return {
                status: "unavailable",
                workspaceId,
                reason: "error",
                message: "工作区不属于该项目的 Git 仓库，请单独登记项目。",
              } satisfies GitRepositoryInfo;
          } else if (saved?.commonDir !== info.commonDir) {
            const commonDir = info.commonDir;
            const changed = Boolean(saved?.commonDir);
            yield* store.update((state) => ({
              ...state,
              projects: {
                ...state.projects,
                [workspace.projectId]: {
                  ...(changed ? {} : state.projects[workspace.projectId]),
                  commonDir,
                },
              },
            }));
            if (changed)
              info = yield* Effect.promise(() => inspectRepository(workspace.cwd, workspace.id));
          }
        }
        return info;
      });
      return GitRepositoryService.of({
        repository,
        branches: Effect.fn("GitRepositoryService.branches")(function* (workspaceId: string) {
          const info = yield* repository(workspaceId);
          if (info.status !== "ready") return [];
          const output = yield* Effect.tryPromise({
            try: () =>
              runGit(info.root, ["for-each-ref", BRANCH_FORMAT, "refs/heads", "refs/remotes"]),
            catch: () => new CoreError({ code: "WorkspaceUnavailable", message: "无法读取分支" }),
          });
          return parseBranches(output.stdout, info.root);
        }),
        selectGitHubRemote: Effect.fn("GitRepositoryService.selectGitHubRemote")(function* (
          projectId: string,
          remoteName: string | null,
          requestId?: string,
        ) {
          const root = (yield* workspaces.list(projectId)).find(
            (workspace) => workspace.kind === "project-root",
          );
          if (!root) return yield* new CoreError({ code: "NotFound", message: "项目不存在" });
          const info = yield* repository(root.id);
          if (
            remoteName !== null &&
            (info.status !== "ready" ||
              !info.remotes.some((remote) => remote.name === remoteName && remote.github))
          )
            return yield* new CoreError({
              code: "InvalidInput",
              message: "该 remote 不是 GitHub 仓库",
            });
          yield* store.update((state) => {
            const fingerprint = JSON.stringify({ kind: "github-remote", projectId, remoteName });
            if (requestId && state.requests?.[requestId]) {
              if (state.requests[requestId] !== fingerprint)
                throw new CoreError({
                  code: "InvalidInput",
                  message: "该请求 ID 已用于不同的参数",
                });
              return state;
            }
            const { githubRemote: _previous, ...project } = state.projects[projectId] ?? {};
            return {
              ...state,
              ...(requestId ? { requests: { ...state.requests, [requestId]: fingerprint } } : {}),
              projects: {
                ...state.projects,
                [projectId]: {
                  ...project,
                  ...(remoteName === null ? {} : { githubRemote: remoteName }),
                },
              },
            };
          });
          return yield* repository(root.id);
        }),
      });
    }),
  );
}
