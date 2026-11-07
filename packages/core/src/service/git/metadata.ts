import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalRoot } from "../../platform/sandbox/backend.ts";
import { inspectRepository } from "./index.ts";

const contains = (root: string, path: string) => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};

export interface GitMetadataScope {
  readonly readableRoots: string[];
  readonly writableRoots: string[];
  /** The scope reaches configuration or hooks, so only the user may grant it. */
  readonly requiresUser: boolean;
  readonly description?: { commonDir: string; worktreeDir: string; branch?: string };
}

/** Whether the workspace needs its repository's metadata granted at all, and which directories to read. */
export async function gitReadRoots(cwd: string) {
  const info = await inspectRepository(cwd, "");
  return info.status === "ready" && !contains(cwd, info.commonDir) ? [info.commonDir] : [];
}

/**
 * Expands `sandbox.gitMetadata` into the narrowest directories Git writes for this workspace. Landlock grants
 * are additive per directory, so a linked worktree gets its own metadata directory, the shared object store and
 * remote-tracking refs, tags and the current branch's ref directory, never the repository's config or hooks.
 */
export async function gitMetadataScope(cwd: string): Promise<GitMetadataScope> {
  const info = await inspectRepository(cwd, "");
  if (info.status !== "ready")
    throw new Error("当前工作区不是可识别的 Git 仓库，不能申请 gitMetadata");
  const empty = { readableRoots: [], writableRoots: [], requiresUser: false };
  if (contains(cwd, info.gitDir) && contains(cwd, info.commonDir)) return empty;
  const branch = info.head.kind === "detached" ? undefined : info.head.name;
  const description = {
    commonDir: info.commonDir,
    worktreeDir: info.gitDir,
    ...(branch ? { branch } : {}),
  };
  if (!info.linkedWorktree)
    // A main checkout's metadata directory is the whole `.git`, including config and hooks.
    return {
      readableRoots: [info.commonDir],
      writableRoots: [info.gitDir],
      requiresUser: true,
      description,
    };
  const refRoots = branch
    ? [
        join(info.commonDir, "refs", "heads", dirname(branch)),
        join(info.commonDir, "logs", "refs", "heads", dirname(branch)),
      ]
    : [];
  // Fetch/push update remote-tracking refs; fetch also follows tags in a linked worktree.
  refRoots.push(
    join(info.commonDir, "refs", "remotes"),
    join(info.commonDir, "logs", "refs", "remotes"),
    join(info.commonDir, "refs", "tags"),
    join(info.commonDir, "logs", "refs", "tags"),
  );
  const writableRoots = [info.gitDir, join(info.commonDir, "objects"), ...refRoots];
  const common = await canonicalRoot(info.commonDir);
  // Core-expanded roots bypass ordinary user-only checks. A directory alias must not widen that trust.
  for (const root of writableRoots) {
    const expected = resolve(common, relative(info.commonDir, root));
    if ((await canonicalRoot(root)) !== expected)
      throw new Error("Git 元数据路径发生重定向，不能自动扩展授权；请显式申请真实路径");
  }
  // Git creates these lazily; validate parents before mkdir can follow an alias outside the metadata.
  for (const root of refRoots) await mkdir(root, { recursive: true });
  return {
    readableRoots: [info.commonDir],
    writableRoots,
    requiresUser: false,
    description,
  };
}
