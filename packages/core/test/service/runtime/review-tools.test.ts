import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import { createReviewToolRunner } from "../../../src/service/runtime/review-tools.ts";

const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)("git", ["-c", "user.name=Eta", "-c", "user.email=eta@example.com", ...args], {
    cwd,
  });

test("reviewer Git ignores executable repository configuration even without sandbox protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-review-git-"));
  const env = new NodeExecutionEnv({ cwd: root });
  const runner = createReviewToolRunner(async () => env, root);
  try {
    await git(root, "init", "-q");
    await writeFile(join(root, "file.txt"), "before\n");
    await writeFile(join(root, ".gitattributes"), "*.txt diff=unsafe\n");
    await git(root, "add", ".");
    await git(root, "commit", "-qm", "initial");
    const marker = join(root, "executed");
    const script = join(root, "unsafe.sh");
    await writeFile(
      script,
      `#!/bin/sh\necho invoked >> '${marker}'\necho EXECUTED_REPOSITORY_PROGRAM\n`,
      { mode: 0o755 },
    );
    await git(root, "config", "diff.unsafe.textconv", script);
    await git(root, "config", "diff.external", script);
    await git(root, "config", "core.fsmonitor", script);
    await writeFile(join(root, "file.txt"), "after\n");
    for (const args of [
      ["status", "--short"],
      ["diff", "HEAD"],
      ["log", "-p", "-1"],
      ["show", "HEAD"],
    ]) {
      const result = await runner.execute(fauxToolCall("git", { args }), context);
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain("EXECUTED_REPOSITORY_PROGRAM");
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runner.cleanup(context);
    await rm(root, { recursive: true, force: true });
  }
});

test("reviewer file tools allow this repository's metadata and reject symlinks to unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-review-roots-"));
  const workspace = join(root, "workspace");
  const common = join(root, "common");
  await mkdir(workspace);
  await mkdir(common);
  await writeFile(join(common, "HEAD"), "ref: refs/heads/main");
  await writeFile(join(root, "secret"), "do not read");
  await symlink(join(root, "secret"), join(workspace, "escape"));
  const env = new NodeExecutionEnv({ cwd: workspace });
  const runner = createReviewToolRunner(async () => env, workspace, [common]);
  try {
    expect(
      await runner.execute(fauxToolCall("read", { path: join(common, "HEAD") }), context),
    ).toMatchObject({ isError: false, text: "ref: refs/heads/main" });
    expect(await runner.execute(fauxToolCall("list", { path: common }), context)).toMatchObject({
      isError: false,
      text: "- HEAD",
    });
    const rejected = await runner.execute(fauxToolCall("read", { path: "escape" }), context);
    expect(rejected.isError).toBe(true);
    expect(rejected.text).not.toContain("do not read");
    expect(
      await runner.execute(fauxToolCall("grep", { path: common, pattern: "ref" }), context),
    ).toMatchObject({ isError: true, text: "grep 只能搜索工作区" });
  } finally {
    await runner.cleanup(context);
    await rm(root, { recursive: true, force: true });
  }
});
