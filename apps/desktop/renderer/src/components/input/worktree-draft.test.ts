import { expect, test } from "vite-plus/test";
import { newWorktreeBranch } from "./worktree-draft";

test("new branches preserve local, remote and already selected bases", () => {
  expect(newWorktreeBranch({ kind: "existing", name: "feature/base" }, "1234")).toMatchObject({
    kind: "new",
    baseRef: "feature/base",
  });
  expect(
    newWorktreeBranch({ kind: "new", name: "eta/old", baseRef: "origin/main" }, "1234"),
  ).toMatchObject({ baseRef: "origin/main" });
  expect(newWorktreeBranch(undefined, "1234")).toEqual({ kind: "new", name: "eta/work-1234" });
});
