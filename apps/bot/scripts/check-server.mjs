import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Check the deployed API using its server-side token, without putting it in logs or argv.
const config = JSON.parse(await readFile("/etc/eta-bot/config.json", "utf8"));
const base = `http://127.0.0.1:${config.port ?? 8080}`;
for (const path of ["/readyz", "/v1/status"]) {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${config.adminToken}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  await response.json();
}

const expectFullAccess = process.argv.includes("--expect-full-access");
const expectNoFullAccess = process.argv.includes("--expect-no-full-access");
assert.ok(!(expectFullAccess && expectNoFullAccess), "conflicting sandbox mode expectations");
if (expectFullAccess || expectNoFullAccess) {
  const response = await fetch(`${base}/v1/library`, {
    headers: { authorization: `Bearer ${config.adminToken}` },
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(response.status, 200);
  const library = await response.json();
  const allowsFullAccess =
    Array.isArray(library.allowedSandboxModes) &&
    library.allowedSandboxModes.includes("danger-full-access");
  assert.equal(
    allowsFullAccess,
    expectFullAccess,
    "deployed sandbox mode policy does not match enable_full_access",
  );
}

// Readiness includes real restricted execution under the service account on this kernel.
const { SandboxedExecutionEnv } = await import("../dist/runtime.mjs");
const workspaceRoot = await mkdtemp(join(config.workspaceRoot, ".deploy-check-"));
let sandbox;
try {
  sandbox = await SandboxedExecutionEnv.open(
    { mode: "workspace-write", workspaceRoot },
    { workerPath: fileURLToPath(new URL("../dist/sandbox-worker.mjs", import.meta.url)) },
  );
  const written = await sandbox.writeFile("probe.txt", "deployment-check", {});
  assert.ok(written.ok, written.error?.message);
  const executed = await sandbox.exec("printf deployment-check", { timeout: 5 }, {});
  assert.ok(executed.ok, executed.error?.message);
  assert.equal(executed.value.exitCode, 0);
} finally {
  await sandbox?.cleanup({});
  await rm(workspaceRoot, { recursive: true, force: true });
}
