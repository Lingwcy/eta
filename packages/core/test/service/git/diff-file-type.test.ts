import { execFile } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { readWorkspaceChanges, readWorkspaceFileDiff } from "../../../src/service/git/diff.ts";

const replacement = vi.hoisted(() => ({
  path: "",
  apply: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const info = await fs.lstat(...args);
      if (args[0] === replacement.path && args[1] === undefined && replacement.apply) {
        const apply = replacement.apply;
        replacement.apply = undefined;
        await apply();
      }
      return info;
    },
  };
});
const run = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  replacement.apply = undefined;
  replacement.path = "";
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32").each(["regular", "fifo"])(
  "workspace diff does not wait for a FIFO writer after a %s file check",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-diff-file-type-"));
    directories.push(directory);
    const cwd = join(directory, "repo");
    await mkdir(cwd);
    const git = (...args: string[]) =>
      run("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], { cwd });
    await git("init", "-q", "-b", "main");
    const path = join(cwd, "file.txt");
    await writeFile(path, "original\n");
    await git("add", ".");
    await git("commit", "-q", "-m", "initial");
    await writeFile(path, "working\n");
    const changes = await readWorkspaceChanges(cwd, { workspaceId: "workspace", scope: "all" });
    if (changes.status !== "ready") throw new Error("Expected repository");
    let replaced = false;
    if (kind === "fifo") {
      replacement.path = path;
      replacement.apply = async () => {
        await rm(path);
        await run("mkfifo", [path]);
        replaced = true;
      };
    }
    let settled = false;
    const result = readWorkspaceFileDiff(cwd, {
      workspaceId: "workspace",
      scope: "all",
      entryId: changes.files[0]!.id,
      expectedRevision: changes.revision,
    }).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    let writer: number | undefined;
    try {
      if (kind === "fifo") await expect.poll(() => replaced, { timeout: 5000 }).toBe(true);
      // No writer exists until finally: a read-only diff must finish without a peer opening the FIFO.
      await expect.poll(() => settled, { timeout: 2000 }).toBe(true);
      if (kind === "fifo") {
        expect(await result).toEqual({ value: { status: "unavailable", reason: "unsupported" } });
        expect((await lstat(path)).isFIFO()).toBe(true);
      } else {
        expect(await result).toMatchObject({
          value: {
            status: "ready",
            path: "file.txt",
            patch: expect.stringContaining("-original\n+working"),
          },
        });
      }
      expect((await git("show", "HEAD:file.txt")).stdout).toBe("original\n");
    } finally {
      // Unblock the original implementation too; nonblocking sync open does not need a free libuv worker.
      if (replaced) {
        try {
          writer = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENXIO")) throw error;
        }
      }
      try {
        await result;
      } finally {
        if (writer !== undefined) closeSync(writer);
      }
    }
  },
  15_000,
);
