import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vite-plus/test";
import * as gitPlatform from "../../../src/platform/git.ts";
import {
  readWorkspaceChanges,
  readWorkspaceFileDiff,
  WORKSPACE_DIFF_MAX_FILE_BYTES,
} from "../../../src/service/git/diff.ts";
import type { WorkspaceDiffScope } from "../../../src/shared/diff.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd });
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(commit = true) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "eta-workspace-diff-test-")));
  directories.push(directory);
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  await git(cwd, "init", "-q", "-b", "main");
  await writeFile(join(cwd, "file.txt"), "original\n");
  if (commit) {
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-q", "-m", "initial");
  }
  return { directory, cwd };
}

async function list(cwd: string, scope: WorkspaceDiffScope = "all") {
  const value = await readWorkspaceChanges(cwd, { workspaceId: "workspace", scope });
  if (value.status !== "ready") throw new Error("Expected repository");
  return value;
}
async function file(cwd: string, path: string, scope: WorkspaceDiffScope = "all") {
  const changes = await list(cwd, scope);
  const entry = changes.files.find((entry) => entry.path === path);
  if (!entry) throw new Error(`Missing diff: ${path}`);
  return readWorkspaceFileDiff(cwd, {
    workspaceId: changes.workspaceId,
    scope,
    entryId: entry.id,
    expectedRevision: changes.revision,
  });
}
async function patch(cwd: string, path: string, scope: WorkspaceDiffScope = "all") {
  const value = await file(cwd, path, scope);
  if (value.status !== "ready") throw new Error(`Expected patch: ${JSON.stringify(value)}`);
  return value.patch;
}

test("all, staged and unstaged compare their own baselines without changing repository state", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "staged\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "working\n");
  const before = await readFile(join(cwd, ".git", "index"));
  const head = (await git(cwd, "rev-parse", "HEAD")).stdout;
  expect(await patch(cwd, "file.txt", "all")).toContain("-original\n+working");
  expect(await patch(cwd, "file.txt", "staged")).toContain("-original\n+staged");
  expect(await patch(cwd, "file.txt", "unstaged")).toContain("-staged\n+working");
  expect((await list(cwd)).files).toMatchObject([
    { path: "file.txt", staged: true, unstaged: true },
  ]);
  expect(await readFile(join(cwd, ".git", "index"))).toEqual(before);
  expect((await git(cwd, "rev-parse", "HEAD")).stdout).toBe(head);
  expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("working\n");
});

test("a staged change reversed in the working tree remains listed with an empty net diff", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "staged\n");
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "original\n");
  expect((await list(cwd)).files).toHaveLength(1);
  expect(await patch(cwd, "file.txt")).toBe("");
});

test("staged deletion plus untracked recreation compares HEAD to actual content once", async () => {
  const { cwd } = await fixture();
  await git(cwd, "rm", "-q", "file.txt");
  await writeFile(join(cwd, "file.txt"), "recreated\n");
  expect((await list(cwd)).files).toHaveLength(1);
  expect(await patch(cwd, "file.txt")).toContain("-original\n+recreated");
  expect(await patch(cwd, "file.txt", "staged")).toContain("-original");
  expect(await patch(cwd, "file.txt", "unstaged")).toContain("+recreated");
});

test("new, ignored, deleted and unusual literal pathnames are handled without path splitting", async () => {
  const { cwd } = await fixture();
  const names = [
    "space name.txt",
    "line\nname.txt",
    '引号"文件.txt',
    "-leading.txt",
    ":[glob]*.txt",
  ];
  for (const name of names) await writeFile(join(cwd, name), "new\n");
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "ignored.txt"), "hidden");
  await rm(join(cwd, "file.txt"));
  const entries = (await list(cwd)).files;
  expect(entries.map((entry) => entry.path)).not.toContain("ignored.txt");
  for (const name of names) {
    expect(entries.find((entry) => entry.path === name)?.kind).toBe("untracked");
    expect(await patch(cwd, name)).toContain("+new");
  }
  expect(await patch(cwd, "file.txt")).toContain("-original");
  expect((await list(cwd, "staged")).files).toHaveLength(0);
});

test("unborn repositories support index and worktree additions and empty files", async () => {
  const { cwd } = await fixture(false);
  await git(cwd, "add", "file.txt");
  await writeFile(join(cwd, "file.txt"), "working\n");
  await writeFile(join(cwd, "empty.txt"), "");
  expect(await patch(cwd, "file.txt")).toContain("+working");
  expect(await patch(cwd, "file.txt", "staged")).toContain("+original");
  expect(await patch(cwd, "file.txt", "unstaged")).toContain("-original\n+working");
  expect(await patch(cwd, "empty.txt")).toContain("new file mode");
});

test("staged rename preserves both paths while unstaged diff uses the new index path", async () => {
  const { cwd } = await fixture();
  await git(cwd, "mv", "file.txt", "renamed.txt");
  expect((await list(cwd)).files).toMatchObject([
    { path: "renamed.txt", oldPath: "file.txt", kind: "renamed" },
  ]);
  expect(await patch(cwd, "renamed.txt")).toContain('rename from "file.txt"');
  await writeFile(join(cwd, "renamed.txt"), "changed\n");
  expect(await patch(cwd, "renamed.txt", "unstaged")).toContain("-original\n+changed");
});

test("a subdirectory workspace and linked worktree never expose sibling paths", async () => {
  const { cwd, directory } = await fixture();
  await mkdir(join(cwd, "pkg"));
  await writeFile(join(cwd, "pkg", "inside.txt"), "before\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-q", "-m", "package");
  const linked = join(directory, "linked");
  await git(cwd, "worktree", "add", "-q", "-b", "feature", linked);
  await writeFile(join(linked, "file.txt"), "outside\n");
  await writeFile(join(linked, "pkg", "inside.txt"), "after\n");
  const nested = join(linked, "pkg");
  expect((await list(nested)).files.map((entry) => entry.path)).toEqual(["inside.txt"]);
  expect(await patch(nested, "inside.txt")).toContain("-before\n+after");
  const selected = (await list(linked)).files.find((entry) => entry.path === "file.txt")!;
  const changes = await list(nested);
  expect(
    await readWorkspaceFileDiff(nested, {
      workspaceId: "workspace",
      scope: "all",
      entryId: selected.id,
      expectedRevision: changes.revision,
    }),
  ).toEqual({ status: "unavailable", reason: "stale" });
});

test("stale revision rejects content, index and HEAD replacement", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "first\n");
  const changes = await list(cwd);
  const input = {
    workspaceId: "workspace",
    scope: "all" as const,
    entryId: changes.files[0]!.id,
    expectedRevision: changes.revision,
  };
  await writeFile(join(cwd, "file.txt"), "other\n");
  expect(await readWorkspaceFileDiff(cwd, input)).toEqual({
    status: "unavailable",
    reason: "stale",
  });
  const second = await list(cwd);
  await git(cwd, "add", "file.txt");
  expect(await readWorkspaceFileDiff(cwd, { ...input, expectedRevision: second.revision })).toEqual(
    { status: "unavailable", reason: "stale" },
  );
  const third = await list(cwd);
  await git(cwd, "commit", "-q", "-m", "new head");
  expect(await readWorkspaceFileDiff(cwd, { ...input, expectedRevision: third.revision })).toEqual({
    status: "unavailable",
    reason: "stale",
  });
});

test("binary, oversized, long-line and symlink contents are explicit unavailable states", async () => {
  const { cwd, directory } = await fixture();
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(cwd, "large.txt"), "x".repeat(WORKSPACE_DIFF_MAX_FILE_BYTES + 1));
  await writeFile(join(cwd, "long.txt"), "x".repeat(20001));
  await writeFile(join(directory, "secret.txt"), "never read");
  await symlink(join(directory, "secret.txt"), join(cwd, "link.txt"));
  expect(await file(cwd, "binary.bin")).toEqual({ status: "unavailable", reason: "binary" });
  expect(await file(cwd, "large.txt")).toEqual({ status: "unavailable", reason: "too-large" });
  expect(await file(cwd, "long.txt")).toEqual({ status: "unavailable", reason: "too-large" });
  expect(await file(cwd, "link.txt")).toEqual({ status: "unavailable", reason: "symlink" });
  await git(cwd, "add", "large.txt");
  expect(await file(cwd, "large.txt", "staged")).toEqual({
    status: "unavailable",
    reason: "too-large",
  });
});

test("conflicts and submodule entries are not parsed as ordinary two-sided text", async () => {
  const { cwd } = await fixture();
  const initial = (await git(cwd, "rev-parse", "HEAD")).stdout.trim();
  await git(cwd, "update-index", "--add", "--cacheinfo", `160000,${initial},module`);
  expect((await list(cwd, "staged")).files.find((entry) => entry.path === "module")?.kind).toBe(
    "submodule",
  );
  expect(await file(cwd, "module", "staged")).toEqual({
    status: "unavailable",
    reason: "submodule",
  });
  await git(cwd, "reset", "-q", "HEAD");
  await git(cwd, "checkout", "-q", "-b", "other");
  await writeFile(join(cwd, "file.txt"), "branch\n");
  await git(cwd, "commit", "-qam", "branch");
  await git(cwd, "checkout", "-q", "main");
  await writeFile(join(cwd, "file.txt"), "main\n");
  await git(cwd, "commit", "-qam", "main");
  await git(cwd, "merge", "other").catch(() => {});
  expect((await list(cwd)).files[0]?.kind).toBe("conflicted");
  expect(await file(cwd, "file.txt")).toEqual({ status: "unavailable", reason: "conflicted" });
});

test("nonrepositories differ from failed Git reads and corrupt index can recover", async () => {
  const { directory, cwd } = await fixture();
  const plain = join(directory, "plain");
  await mkdir(plain);
  expect(await readWorkspaceChanges(plain, { workspaceId: "plain", scope: "all" })).toEqual({
    status: "not-repository",
    workspaceId: "plain",
  });
  await writeFile(join(cwd, "file.txt"), "changed\n");
  const index = join(cwd, ".git", "index");
  const bytes = await readFile(index);
  await writeFile(index, "broken");
  await expect(list(cwd)).rejects.toMatchObject({ code: "WorkspaceUnavailable" });
  await writeFile(index, bytes);
  expect((await list(cwd)).files.map((entry) => entry.path)).toEqual(["file.txt"]);
});

test("repository diff drivers and textconv are never executed for the preview", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, ".gitattributes"), "*.txt diff=custom\n");
  await git(cwd, "config", "diff.external", "false");
  await git(cwd, "config", "diff.custom.command", "false");
  await git(cwd, "config", "diff.custom.textconv", "false");
  await writeFile(join(cwd, "file.txt"), "changed\n");
  expect(await patch(cwd, "file.txt")).toContain("-original\n+changed");
});

test("repository directory names containing newline remain unambiguous", async () => {
  const { cwd, directory } = await fixture();
  const renamed = join(directory, "repo\nline\n");
  await rename(cwd, renamed);
  await writeFile(join(renamed, "file.txt"), "changed\n");
  expect(await patch(renamed, "file.txt")).toContain("-original\n+changed");
});

test("BOM, CRLF and missing final newline are retained in the actual text comparison", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "\ufefforiginal\r\nlast");
  await git(cwd, "add", "file.txt");
  await git(cwd, "commit", "-q", "-m", "line endings");
  await writeFile(join(cwd, "file.txt"), "\ufeffchanged\r\nlast");
  const value = await patch(cwd, "file.txt");
  expect(value).toContain("-\ufefforiginal\r\n+\ufeffchanged\r\n");
  expect(value).toContain("\\ No newline at end of file");
});

test("large file lists are explicitly bounded instead of silently complete", async () => {
  const { cwd } = await fixture();
  for (let batch = 0; batch < 11; batch++) {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(cwd, `new-${batch * 100 + index}.txt`), "content\n"),
      ),
    );
  }
  const value = await list(cwd);
  expect(value.files).toHaveLength(1000);
  expect(value.truncated).toBe(true);
});

test("non-UTF8 tracked content is not silently converted to replacement characters", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), Buffer.from([0xff, 0xfe, 10]));
  await git(cwd, "add", "file.txt");
  expect(await file(cwd, "file.txt", "staged")).toEqual({
    status: "unavailable",
    reason: "binary",
  });
});

test("a file changed during patch generation cannot publish against the older list", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "first\n");
  const changes = await list(cwd);
  const original = gitPlatform.runGit;
  vi.spyOn(gitPlatform, "runGit").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1].includes("--no-index")) await writeFile(join(cwd, "file.txt"), "replacement\n");
    return result;
  });
  expect(
    await readWorkspaceFileDiff(cwd, {
      workspaceId: "workspace",
      scope: "all",
      entryId: changes.files[0]!.id,
      expectedRevision: changes.revision,
    }),
  ).toEqual({ status: "unavailable", reason: "stale" });
});

test("detached HEAD and file-mode-only changes still produce a read-only preview", async () => {
  const { cwd } = await fixture();
  await git(cwd, "checkout", "-q", "--detach");
  await git(cwd, "update-index", "--chmod=+x", "file.txt");
  const value = await patch(cwd, "file.txt", "staged");
  expect(value).toContain("old mode 100644");
  expect(value).toContain("new mode 100755");
});

test("a legitimate UTF8 replacement character is text while malformed byte sequences are binary", async () => {
  const { cwd } = await fixture();
  await writeFile(join(cwd, "file.txt"), "valid \ufffd Unicode\n");
  await git(cwd, "add", "file.txt");
  expect(await patch(cwd, "file.txt", "staged")).toContain("+valid \ufffd Unicode");
  // An incomplete four-byte sequence decodes to one U+FFFD: both encodings have three bytes.
  await writeFile(join(cwd, "invalid.txt"), Buffer.from([0xf0, 0x90, 0x80]));
  await git(cwd, "add", "invalid.txt");
  expect(await file(cwd, "invalid.txt", "staged")).toEqual({
    status: "unavailable",
    reason: "binary",
  });
});

test("core.filemode=false ignores physical executable bits but retains staged mode changes", async () => {
  const { cwd } = await fixture();
  await git(cwd, "config", "core.filemode", "false");
  await chmod(join(cwd, "file.txt"), 0o755);
  await writeFile(join(cwd, "file.txt"), "working\n");
  for (const scope of ["all", "unstaged"] as const) {
    const value = await patch(cwd, "file.txt", scope);
    expect(value).toContain("-original\n+working");
    expect(value).not.toContain("old mode");
    expect(value).not.toContain("new mode");
  }
  await git(cwd, "update-index", "--chmod=+x", "file.txt");
  await chmod(join(cwd, "file.txt"), 0o644);
  await writeFile(join(cwd, "file.txt"), "later\n");
  expect(await patch(cwd, "file.txt", "staged")).toContain("new mode 100755");
  expect(await patch(cwd, "file.txt", "all")).toContain("new mode 100755");
  expect(await patch(cwd, "file.txt", "unstaged")).not.toContain("old mode");
});
