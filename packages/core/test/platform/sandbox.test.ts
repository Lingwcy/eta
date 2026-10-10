import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { getOrThrow } from "@eta/agent/env";
import { SandboxedExecutionEnv } from "../../src/platform/sandbox/environment.ts";
import { sandboxStatus } from "../../src/platform/sandbox/backend.ts";
import type { SandboxMode, SandboxPolicy } from "../../src/shared/sandbox.ts";

const directories: string[] = [];
const environments: SandboxedExecutionEnv[] = [];
afterEach(async () => {
  for (const env of environments.splice(0)) await env.cleanup(context);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const runtimeRoots = [fileURLToPath(new URL("../../../../", import.meta.url))];
async function fixture(
  mode: SandboxMode = "workspace-write",
  access: Pick<SandboxPolicy, "networkAccess" | "commandAccess"> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "eta-sandbox-test-"));
  directories.push(directory);
  const workspaceRoot = join(directory, "project");
  const outside = join(directory, "other-project");
  const credentials = join(process.platform === "linux" ? directory : workspaceRoot, "credentials");
  await mkdir(workspaceRoot);
  await mkdir(outside);
  await mkdir(credentials);
  await writeFile(join(workspaceRoot, "read.txt"), "first\nsecond\n");
  await writeFile(join(outside, "secret.txt"), "private");
  await writeFile(join(credentials, "token.txt"), "token");
  const env = await SandboxedExecutionEnv.open(
    { mode, workspaceRoot, deniedRoots: [credentials], ...access },
    { runtimeRoots },
  );
  environments.push(env);
  return { directory, workspaceRoot, outside, credentials, env };
}

const native = await sandboxStatus({ mode: "workspace-write", workspaceRoot: process.cwd() });
test.skipIf(!native.available)(
  "native sandbox permits workspace edits and streaming reads while blocking other projects and protected paths",
  async () => {
    const { env, workspaceRoot, outside, credentials } = await fixture();
    expect(getOrThrow(await env.readTextFile("read.txt", context))).toBe("first\nsecond\n");
    const reader = getOrThrow(await env.openTextLineReader("read.txt", context));
    expect(getOrThrow(await reader.readLine(context))).toEqual({ text: "first", terminated: true });
    await reader.close(context);
    getOrThrow(await env.writeFile("created.txt", "written", context));
    expect(await readFile(join(workspaceRoot, "created.txt"), "utf8")).toBe("written");
    expect(await env.writeFile(join(outside, "created.txt"), "escaped", context)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(await env.readTextFile(join(outside, "secret.txt"), context)).toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    expect(await env.readTextFile(join(credentials, "token.txt"), context)).toMatchObject({
      ok: false,
    });
    expect(
      await env.writeFile(join(credentials, "token.txt"), "replacement", context),
    ).toMatchObject({ ok: false });
  },
);

test.skipIf(!native.available)(
  "shell descendants cannot escape through relative paths or symlinks and receive no host tokens",
  async () => {
    const { env, workspaceRoot, outside } = await fixture();
    await symlink(outside, join(workspaceRoot, "escape"));
    expect(await env.writeFile("escape/escaped.txt", "escaped", context)).toMatchObject({
      ok: false,
    });
    let output = "";
    const result = getOrThrow(
      await env.exec(
        "sh -c 'printf changed > ../other-project/secret.txt'",
        {
          onOutput: (text) => {
            output += text;
          },
        },
        context,
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("private");
    expect(output).toMatch(/permitted|denied|Permission/i);
    const key = "ETA_SANDBOX_TEST_TOKEN";
    const previous = process.env[key];
    process.env[key] = "must-not-reach-the-command";
    try {
      let tokenOutput = "";
      getOrThrow(
        await env.exec(
          `printf '%s' "$${key}"`,
          {
            onOutput: (text) => {
              tokenOutput += text;
            },
          },
          context,
        ),
      );
      expect(tokenOutput).toBe("");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  },
);

test.skipIf(!native.available)(
  "read-only native enforcement blocks direct writes and shell writes",
  async () => {
    const { env } = await fixture("read-only");
    expect(await env.writeFile("write.txt", "forbidden", context)).toMatchObject({ ok: false });
    expect(await env.exec("printf forbidden > write.txt", undefined, context)).toMatchObject({
      ok: false,
    });
    expect(getOrThrow(await env.readTextFile("read.txt", context))).toContain("first");
  },
);

test.skipIf(!native.available).each([
  { mode: "workspace-write", access: {}, allowed: true },
  { mode: "workspace-write", access: { networkAccess: false }, allowed: false },
  { mode: "read-only", access: { commandAccess: true }, allowed: false },
  { mode: "read-only", access: { commandAccess: true, networkAccess: true }, allowed: true },
] as const)(
  "native $mode network policy (allowed: $allowed, access: $access)",
  async ({ mode, access, allowed }) => {
    const { env } = await fixture(mode, access);
    const server = createServer((_request, response) => response.end("reachable"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test server address");
      let output = "";
      const result = getOrThrow(
        await env.exec(
          `/usr/bin/curl --silent --show-error --max-time 2 --noproxy '*' http://127.0.0.1:${address.port}`,
          {
            timeout: 5,
            onOutput: (text) => {
              output += text;
            },
          },
          context,
        ),
      );
      if (allowed) {
        expect(result.exitCode).toBe(0);
        expect(output).toBe("reachable");
      } else expect(result.exitCode).not.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

test("full access deliberately removes the native file boundary", async () => {
  const { env, outside } = await fixture("danger-full-access");
  expect(env.status).toMatchObject({ backend: "none", mode: "danger-full-access" });
  getOrThrow(await env.writeFile(join(outside, "created.txt"), "authorized", context));
  expect(await readFile(join(outside, "created.txt"), "utf8")).toBe("authorized");
});
