import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";

const configEditor = fileURLToPath(new URL("../scripts/apply-sandbox-modes.cjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function deployConfig(config: object, enableFullAccess: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "eta-bot-deploy-config-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  execFileSync(process.execPath, [configEditor, path, String(enableFullAccess)]);
  return JSON.parse(await readFile(path, "utf8"));
}

test("false removes full access and preserves explicitly configured restricted modes", async () => {
  const config = await deployConfig(
    { allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"] },
    false,
  );
  expect(config.allowedSandboxModes).toEqual(["read-only", "workspace-write"]);
});

test("true adds full access without replacing explicitly configured modes", async () => {
  const config = await deployConfig({ allowedSandboxModes: ["read-only"] }, true);
  expect(config.allowedSandboxModes).toEqual(["read-only", "danger-full-access"]);
});

test("an omitted allowlist defaults to restricted modes when full access is disabled", async () => {
  const config = await deployConfig({}, false);
  expect(config.allowedSandboxModes).toEqual(["read-only", "workspace-write"]);
});

test("an omitted allowlist gains full access only when explicitly enabled", async () => {
  const config = await deployConfig({}, true);
  expect(config.allowedSandboxModes).toEqual([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]);
});
