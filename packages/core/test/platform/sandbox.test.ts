import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { WatchChange } from "@eta/agent/env";
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
  "Git remains usable when a system config exists outside the sandbox's readable roots",
  async () => {
    const { env, outside } = await fixture();
    const systemConfig = join(outside, "gitconfig");
    await writeFile(systemConfig, "[alias]\n  host-only = !echo host-config\n");
    expect(await env.readTextFile(systemConfig, context)).toMatchObject({ ok: false });
    let output = "";
    const result = getOrThrow(
      await env.exec(
        "git init -q -b main && git status --short && git config --list",
        {
          env: { GIT_CONFIG_SYSTEM: systemConfig },
          onOutput: (value) => {
            output += value;
          },
        },
        context,
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(output).toContain("?? read.txt");
    expect(output).not.toContain("host-config");
  },
);

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

test.skipIf(!native.available)(
  "bounded readers, argv commands and watches cross the native worker boundary",
  async () => {
    const { env, outside } = await fixture();
    const reader = getOrThrow(await env.openBinaryReader("read.txt", undefined, context));
    try {
      expect(getOrThrow(await reader.info(context)).size).toBe(13);
      expect(Buffer.from(getOrThrow(await reader.read(6, 6, context))).toString()).toBe("second");
      expect(
        getOrThrow(await reader.scanLines({ startLine: 1, endLine: 2 }, context)),
      ).toMatchObject({
        newlines: 2,
        start: 6,
        end: 12,
        selectedBytes: 6,
      });
      getOrThrow(await env.renameFile("read.txt", "renamed.txt", context));
      expect(Buffer.from(getOrThrow(await reader.read(0, 5, context))).toString()).toBe("first");
    } finally {
      await reader.close(context);
    }
    expect(
      await env.openBinaryReader(join(outside, "secret.txt"), undefined, context),
    ).toMatchObject({ ok: false });
    getOrThrow(await env.createDir("listing", undefined, context));
    getOrThrow(await env.writeFile("listing/item.txt", "item", context));
    const directory = getOrThrow(await env.openDirReader("listing", context));
    const names: string[] = [];
    try {
      for (;;) {
        const page = getOrThrow(await directory.next(1, context));
        expect(page.entries.length).toBeLessThanOrEqual(1);
        names.push(...page.entries.map((entry) => entry.path));
        if (page.done) break;
      }
    } finally {
      await directory.close(context);
    }
    expect(names.some((path) => path.endsWith("item.txt"))).toBe(true);
    const chunks: { text: string; stream: string }[] = [];
    const command = getOrThrow(
      await env.exec(
        ["/bin/sh", "-c", "printf '%s' \"$1\"; printf problem >&2", "sh", "literal; echo unsafe"],
        {
          onOutput: (text, _context, info) => {
            chunks.push({ text, stream: info.stream });
          },
        },
        context,
      ),
    );
    expect(command.exitCode).toBe(0);
    expect(
      chunks
        .filter((chunk) => chunk.stream === "stdout")
        .map((chunk) => chunk.text)
        .join(""),
    ).toBe("literal; echo unsafe");
    expect(
      chunks
        .filter((chunk) => chunk.stream === "stderr")
        .map((chunk) => chunk.text)
        .join(""),
    ).toBe("problem");
    const changes: WatchChange[] = [];
    const watcher = getOrThrow(
      await env.watch(
        [{ path: "renamed.txt" }],
        (change) => {
          changes.push(change);
        },
        context,
      ),
    );
    try {
      getOrThrow(await env.appendFile("renamed.txt", "third", context));
      await expect
        .poll(() => changes.some((change) => "paths" in change || "overflow" in change), {
          timeout: 5000,
        })
        .toBe(true);
    } finally {
      await watcher.close(context);
    }
    const count = changes.length;
    getOrThrow(await env.appendFile("renamed.txt", "fourth", context));
    expect(changes).toHaveLength(count);
  },
);
