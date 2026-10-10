import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distribution = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../dist/", import.meta.url)),
);
const { SandboxedExecutionEnv } = await import(
  pathToFileURL(join(distribution, "runtime.mjs")).href
);
const root = await mkdtemp(join(tmpdir(), "eta-native-verification-"));
const workspaceRoot = join(root, "workspace");
const outside = join(root, "outside");
const context = {};
const environments = [];
const open = async (mode = "workspace-write", grant = {}) => {
  const env = await SandboxedExecutionEnv.open(
    { mode, workspaceRoot, ...grant },
    { workerPath: join(distribution, "sandbox-worker.mjs") },
  );
  environments.push(env);
  return env;
};
const value = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const server = createServer((_request, response) => response.end("approved network"));
try {
  await mkdir(workspaceRoot);
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "protected");
  const env = await open();
  assert.equal(env.status.available, true);
  value(await env.writeFile("file.txt", "allowed", context));
  assert.equal(value(await env.readTextFile("file.txt", context)), "allowed");
  assert.equal((await env.writeFile(join(outside, "escape.txt"), "forbidden", context)).ok, false);
  assert.equal((await env.readTextFile(join(outside, "secret.txt"), context)).ok, false);
  await symlink(outside, join(workspaceRoot, "escape"));
  assert.equal((await env.readTextFile("escape/secret.txt", context)).ok, false);
  assert.equal((await env.truncateFile("escape/secret.txt", 0, context)).ok, false);
  assert.equal((await env.renameFile("file.txt", join(outside, "file.txt"), context)).ok, false);
  assert.notEqual(
    value(await env.exec("sh -c 'printf forbidden > ../outside/secret.txt'", undefined, context))
      .exitCode,
    0,
  );
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "protected");
  const readonly = await open("read-only");
  assert.equal((await readonly.writeFile("readonly.txt", "forbidden", context)).ok, false);
  assert.equal(
    (await readonly.exec("printf forbidden > readonly.txt", undefined, context)).ok,
    false,
  );
  const approvedCommand = await open("read-only", { commandAccess: true });
  assert.notEqual(
    value(await approvedCommand.exec("printf forbidden > readonly.txt", undefined, context))
      .exitCode,
    0,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const fetchCommand = `${process.execPath} -e 'fetch("${url}").then(r=>r.text()).then(console.log).catch(()=>process.exit(3))'`;
  assert.notEqual(
    value(await approvedCommand.exec(fetchCommand, { timeout: 5 }, context)).exitCode,
    0,
  );
  const network = env;
  let output = "";
  assert.equal(
    value(
      await network.exec(
        fetchCommand,
        {
          timeout: 5,
          onOutput: (text) => {
            output += text;
          },
        },
        context,
      ),
    ).exitCode,
    0,
  );
  assert.match(output, /approved network/);
  const timed = await open();
  assert.equal((await timed.exec("sleep 10", { timeout: 0.05 }, context)).error?.code, "timeout");
  const cancelled = await open();
  const controller = new AbortController();
  const execution = cancelled.exec("sleep 10", undefined, { abortSignal: controller.signal });
  controller.abort();
  assert.equal((await execution).error?.code, "aborted");
  const detached = await open();
  const group = (pid) =>
    process.platform === "linux"
      ? readFileSync(`/proc/${pid}/stat`, "utf8")
          .split(")")
          .slice(1)
          .join(")")
          .trim()
          .split(/\s+/)[2]
      : spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
          encoding: "utf8",
        }).stdout.trim();
  let groups;
  let groupOutput = "";
  const childProgram =
    'setInterval(()=>require("node:fs").appendFileSync("detached-heartbeat.txt","."),10)';
  const detachedProgram = `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childProgram)}],{detached:true,stdio:"ignore"});child.on("error",()=>{console.log(JSON.stringify({blocked:true}));process.exit(0)}).on("spawn",()=>{console.log(JSON.stringify({parent:process.pid,child:child.pid}));setTimeout(()=>process.exit(0),200)})`;
  const escapeGroup = `${quote(process.execPath)} -e ${quote(detachedProgram)}`;
  assert.equal(
    value(
      await detached.exec(
        escapeGroup,
        {
          timeout: 2,
          onOutput: (text) => {
            groupOutput += text;
            if (!groupOutput.includes("\n") || groups) return;
            const report = JSON.parse(groupOutput.split("\n")[0]);
            groups = report.blocked
              ? ["blocked", "blocked"]
              : [group(report.parent), group(report.child)];
          },
        },
        context,
      ),
    ).exitCode,
    0,
  );
  assert.ok(
    groups,
    "Observe the actual process groups, even when spawn ignores a denied setsid call",
  );
  if (process.platform === "linux")
    assert.equal(groups[0], groups[1], "A descendant cannot create a new process group");
  await detached.cleanup(context);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const detachedStopped = await readFile(join(workspaceRoot, "detached-heartbeat.txt"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await readFile(join(workspaceRoot, "detached-heartbeat.txt"), "utf8"),
    detachedStopped,
    "Cleanup stops descendants even when they detach or are reparented",
  );
  assert.equal(
    value(await env.readTextFile("file.txt", context)),
    "allowed",
    "Other invocations remain usable after cleanup",
  );
  const background = await open();
  value(
    await background.exec(
      `${process.execPath} -e 'setInterval(()=>require("node:fs").appendFileSync("heartbeat.txt","."),10)' >/dev/null 2>&1 & sleep 0.1`,
      undefined,
      context,
    ),
  );
  await background.cleanup(context);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = await readFile(join(workspaceRoot, "heartbeat.txt"), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await readFile(join(workspaceRoot, "heartbeat.txt"), "utf8"), stopped);
  const full = await open("danger-full-access");
  value(await full.writeFile(join(outside, "explicit-full.txt"), "allowed", context));
  console.log(
    `Native ${env.status.backend} verified: files, links, rename/truncate, descendant commands, network grants, timeout, cancellation and process cleanup.`,
  );
} finally {
  for (const env of environments) await env.cleanup(context);
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
