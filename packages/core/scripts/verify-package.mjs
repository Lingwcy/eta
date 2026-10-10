import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxedExecutionEnv } from "../dist/platform/sandbox/environment.mjs";

const root = await mkdtemp(join(tmpdir(), "eta-core-package-"));
const workspaceRoot = join(root, "project");
const outside = join(root, "outside.txt");
const environments = [];
try {
  await mkdir(workspaceRoot);
  await writeFile(outside, "protected");
  const env = await SandboxedExecutionEnv.open({ mode: "workspace-write", workspaceRoot });
  environments.push(env);
  assert.equal(env.status.available, true);
  assert.equal((await env.writeFile("proof.txt", "compiled Core", {})).ok, true);
  assert.equal(await readFile(join(workspaceRoot, "proof.txt"), "utf8"), "compiled Core");
  assert.equal((await env.readTextFile(outside, {})).ok, false);
  assert.equal((await env.writeFile(outside, "escaped", {})).ok, false);
  const readonly = await SandboxedExecutionEnv.open({ mode: "read-only", workspaceRoot });
  environments.push(readonly);
  assert.equal((await readonly.writeFile("readonly.txt", "escaped", {})).ok, false);
  assert.equal((await readonly.exec("printf unauthorized", undefined, {})).ok, false);
  if (process.platform === "linux") {
    const program = join(workspaceRoot, "syscalls");
    execFileSync("cc", [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      fileURLToPath(new URL("../test/platform/linux-syscalls.c", import.meta.url)),
      "-o",
      program,
    ]);
    const offline = await SandboxedExecutionEnv.open({
      mode: "workspace-write",
      workspaceRoot,
      networkAccess: false,
    });
    environments.push(offline);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const { environment, suffix } of [
      { environment: offline, suffix: "" },
      { environment: env, suffix: " network" },
    ]) {
      let output = "";
      const result = await environment.exec(
        `${quote(program)}${suffix}`,
        {
          onOutput: (text) => {
            output += text;
          },
        },
        {},
      );
      assert.equal(result.ok, true);
      assert.equal(result.value.exitCode, 0, output);
    }
  }
  console.log(`Compiled Core ${env.status.backend} sandbox verified.`);
} finally {
  for (const env of environments) await env.cleanup({});
  await rm(root, { recursive: true, force: true });
}
