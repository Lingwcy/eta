import { execFile } from "node:child_process";

/**
 * Every host-side Git call goes through here. These overrides disable selected execution vectors
 * (fsmonitor, hooks, external diff drivers, pagers and credential helpers), not all repository code.
 * Attribute clean/smudge/process filters are not disabled: status and checkout can still execute
 * configured filter commands on the host. This wrapper is not a sandbox for untrusted Git config;
 * see #355 for the reproduced clean/smudge boundary and the unresolved execution policy.
 */
export const HOST_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
] as const;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitUnavailableError extends Error {}

export function runGit(
  cwd: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...HOST_GIT_CONFIG, ...args],
      {
        cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          // Status must not rewrite the index as a side effect of reading it.
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          LC_ALL: "C",
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && "code" in error && error.code === "ENOENT")
          return reject(new GitUnavailableError("未找到 git 可执行文件"));
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ stdout, stderr, exitCode: error ? Number(error.code) : 0 });
      },
    );
  });
}

export interface GitHubRepository {
  readonly host: "github.com";
  readonly owner: string;
  readonly repo: string;
}

/** Recognises the standard github.com remote forms; other hosts and SSH aliases are not GitHub in V1. */
export function parseGitHubRemote(url: string): GitHubRepository | undefined {
  const match =
    /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url) ??
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url) ??
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (!match) return undefined;
  const [, owner, repo] = match;
  if (!owner || !repo) return undefined;
  return { host: "github.com", owner, repo };
}

/** Remote URLs may embed tokens; DTOs only ever carry the URL without user info. */
export function redactRemoteUrl(url: string) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1");
}
