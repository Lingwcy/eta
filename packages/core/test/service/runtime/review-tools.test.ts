import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vite-plus/test";
import {
  createReviewToolRunner,
  REVIEW_TOOL_OUTPUT_LIMIT,
} from "../../../src/service/runtime/review-tools.ts";

test("reviewer read preserves selected lines, BOM and bounded UTF-8 output", async () => {
  const root = await mkdtemp(join(tmpdir(), "eta-review-lines-"));
  const runner = createReviewToolRunner(async () => new NodeExecutionEnv({ cwd: root }), root);
  try {
    await writeFile(join(root, "lines.txt"), "\uFEFFπ\r\nsecond\n\nlast\n");
    for (const [offset, limit, text] of [
      [1, 1, "\uFEFFπ\r"],
      [2, 2, "second\n"],
      [4, 2, "last\n"],
      [99, 1, ""],
    ] as const) {
      expect(
        await runner.execute(fauxToolCall("read", { path: "lines.txt", offset, limit }), context),
      ).toMatchObject({ isError: false, text });
    }
    for (const extra of [0, 1]) {
      const text = "🙂".repeat(REVIEW_TOOL_OUTPUT_LIMIT / 4 + extra);
      await writeFile(join(root, "long.txt"), text);
      const result = await runner.execute(
        fauxToolCall("read", { path: "long.txt", limit: 1 }),
        context,
      );
      expect(result).toMatchObject({
        isError: false,
        text:
          extra === 0
            ? text
            : text.slice(0, REVIEW_TOOL_OUTPUT_LIMIT / 2) +
              "\n…[output truncated at " +
              REVIEW_TOOL_OUTPUT_LIMIT +
              " bytes]",
      });
    }
  } finally {
    await runner.cleanup(context);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "reviewer reads one line from a large real sandbox file under a 64MiB host heap",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-review-memory-"));
    try {
      await writeFile(join(root, "small.txt"), "head\n");
      const file = await open(join(root, "large.txt"), "w");
      try {
        await file.writeFile("head\n");
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        for (let i = 0; i < 128; i++) await file.writeFile(chunk);
      } finally {
        await file.close();
      }
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--max-old-space-size=64",
          fileURLToPath(new URL("../../fixtures/review-read-memory.mjs", import.meta.url)),
          root,
        ],
        { timeout: 30_000, maxBuffer: 64 * 1024 },
      );
      expect(JSON.parse(stdout)).toEqual([
        { isError: false, text: "head", summary: "read small.txt" },
        { isError: false, text: "head", summary: "read large.txt" },
        {
          isError: false,
          text:
            "a".repeat(REVIEW_TOOL_OUTPUT_LIMIT) +
            "\n…[output truncated at " +
            REVIEW_TOOL_OUTPUT_LIMIT +
            " bytes]",
          summary: "read large.txt",
        },
        { isError: false, text: "head", summary: "read small.txt" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);

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
