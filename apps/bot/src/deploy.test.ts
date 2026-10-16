import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

async function prepareConfig(config: object) {
  const directory = await mkdtemp(join(tmpdir(), "eta-bot-deploy-config-"));
  directories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config));
  return { directory, path };
}

async function deployConfig(config: object, enableFullAccess: boolean) {
  const { directory, path } = await prepareConfig(config);
  execFileSync(process.execPath, [configEditor, path, String(enableFullAccess)]);
  expect(await readdir(directory)).toEqual(["config.json"]);
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

test("false moves an explicit full-access default to an allowed restricted mode", async () => {
  const config = await deployConfig(
    {
      allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
      runtime: { defaultSandboxMode: "danger-full-access" },
    },
    false,
  );
  expect(config.allowedSandboxModes).toEqual(["read-only", "workspace-write"]);
  expect(config.runtime.defaultSandboxMode).toBe("workspace-write");
});

test("false falls back to read-only when full access was the only allowed mode", async () => {
  const config = await deployConfig(
    {
      allowedSandboxModes: ["danger-full-access"],
      runtime: { defaultSandboxMode: "danger-full-access" },
    },
    false,
  );
  expect(config.allowedSandboxModes).toEqual(["read-only"]);
  expect(config.runtime.defaultSandboxMode).toBe("read-only");
});

test("an empty explicit allowlist is rejected without changing the config", async () => {
  const original = { allowedSandboxModes: [] };
  const { directory, path } = await prepareConfig(original);
  let failure: unknown;
  try {
    execFileSync(process.execPath, [configEditor, path, "false"]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as { stderr: Buffer }).stderr.toString()).toContain("Cannot disable full access");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
  expect(await readdir(directory)).toEqual(["config.json"]);
});

test("atomic replacement preserves the config file's private mode", async () => {
  const { directory, path } = await prepareConfig({ allowedSandboxModes: ["workspace-write"] });
  await chmod(path, 0o600);
  await deployConfigFile(path, false);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(["config.json"]);
});

async function deployConfigFile(path: string, enableFullAccess: boolean) {
  execFileSync(process.execPath, [configEditor, path, String(enableFullAccess)]);
}
