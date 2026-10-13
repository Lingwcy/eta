import type { WorktreeBranch } from "@eta/core/service/git/worktrees";
import { worktreeBranchName } from "@eta/core/shared/git";

/** New branches retain the selected branch as their base; an untouched draft uses the checkout's HEAD. */
export function newWorktreeBranch(
  selected: WorktreeBranch | undefined,
  suffix: string,
): WorktreeBranch {
  const baseRef = selected?.kind === "existing" ? selected.name : selected?.baseRef;
  return {
    kind: "new",
    name: worktreeBranchName(baseRef ?? "work", suffix),
    ...(baseRef ? { baseRef } : {}),
  };
}
