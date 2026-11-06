import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@eta/agent/env/node";
import type { ExecutionEnv } from "@eta/agent/env";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test, vi } from "vite-plus/test";
import { SandboxedExecutionEnv } from "../../../src/platform/sandbox/environment.ts";
import { createReviewToolRunner } from "../../../src/service/runtime/review-tools.ts";

test
  .skipIf(process.platform !== "linux" || process.getuid?.() === 0)
  .each(["default", "sh", "sandbox"] as const)(
  "reviewer grep distinguishes failure, no match and bounded output (%s)",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "eta-review-grep-"));
    let runner: ReturnType<typeof createReviewToolRunner> | undefined;
    let restore: (() => void) | undefined;
    try {
      const file = join(root, "locked 'file.txt");
      await writeFile(file, "needle\n", { mode: 0o000 });
      const env: ExecutionEnv =
        kind === "sandbox"
          ? await SandboxedExecutionEnv.open({
              mode: "read-only",
              workspaceRoot: root,
              commandAccess: true,
            })
          : new NodeExecutionEnv({ cwd: root, ...(kind === "sh" ? { shellPath: "/bin/sh" } : {}) });
      const directories: string[] = [];
      const controller = new AbortController();
      let cancelAfterAllocation = false;
      const create = env.createTempDir.bind(env);
      const spy = vi.spyOn(env, "createTempDir").mockImplementation(async (...args) => {
        const result = await create(...args);
        if (result.ok) {
          directories.push(result.value);
          if (cancelAfterAllocation) controller.abort();
        }
        return result;
      });
      restore = () => spy.mockRestore();
      runner = createReviewToolRunner(async () => env, root);
      const search = (pattern: string, path: string) =>
        runner!.execute(fauxToolCall("grep", { pattern, path }), context);
      expect(await search("needle", "locked 'file.txt")).toMatchObject({ isError: true });
      expect(await env.exec(["grep", "-F", "needle", file], undefined, context)).toMatchObject({
        ok: true,
        value: { exitCode: 2 },
      });
      await chmod(file, 0o600);
      const repaired = await search("needle", "locked 'file.txt");
      expect(repaired.isError).toBe(false);
      expect(repaired.text).toBe("1:needle\n");
      expect(await search("absent", "locked 'file.txt")).toMatchObject({
        isError: false,
        text: "(no matches)",
      });
      await mkdir(join(root, "many"));
      for (const name of ["a.txt", "b.txt"])
        await writeFile(join(root, "many", name), ("needle " + "x".repeat(8192) + "\n").repeat(50));
      const limited = await search("needle", "many");
      expect(limited.isError).toBe(false);
      expect(limited.text).toContain("output truncated");
      cancelAfterAllocation = true;
      expect(
        await runner.execute(
          fauxToolCall("grep", { pattern: "needle", path: "many" }),
          withAbortSignal(controller.signal, context),
        ),
      ).toMatchObject({ isError: true });
      for (const path of directories)
        await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restore?.();
      await runner?.cleanup(context);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
