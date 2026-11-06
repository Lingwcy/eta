import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const run = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));

test.each([undefined, "// user-owned declaration"])(
  "Core pack preserves external build helpers (existing declaration: %s)",
  async (existing) => {
    const root = await mkdtemp(join(tmpdir(), "eta-core-build-scope-"));
    const core = join(root, "packages/core");
    try {
      await mkdir(join(root, "scripts"), { recursive: true });
      await mkdir(join(core, "src/platform/sandbox"), { recursive: true });
      await mkdir(join(core, "src/service/runtime"), { recursive: true });
      await symlink(join(repository, "node_modules"), join(root, "node_modules"), "junction");
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
      await cp(join(repository, "tsconfig.base.json"), join(root, "tsconfig.base.json"));
      await cp(
        join(repository, "scripts/published-pi-aliases.ts"),
        join(root, "scripts/published-pi-aliases.ts"),
      );
      for (const file of ["package.json", "vite.config.ts", "tsconfig.json", "tsconfig.build.json"])
        await cp(join(repository, "packages/core", file), join(core, file));
      await writeFile(join(core, "src/index.ts"), 'export const proof = "core-product";\n');
      for (const file of ["platform/sandbox/worker.ts", "service/runtime/codemode-worker.ts"])
        await writeFile(join(core, "src", file), "export const worker = true;\n");
      const declaration = join(root, "scripts/published-pi-aliases.d.ts");
      if (existing !== undefined) await writeFile(declaration, existing);
      await run("vp", ["pack"], { cwd: core, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      expect((await import(pathToFileURL(join(core, "dist/index.mjs")).href)).proof).toBe(
        "core-product",
      );
      expect(await readFile(join(core, "dist/index.d.mts"), "utf8")).toContain("core-product");
      if (existing === undefined)
        await expect(access(declaration)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(declaration, "utf8")).toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);
