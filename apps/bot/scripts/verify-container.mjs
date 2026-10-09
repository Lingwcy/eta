import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
function docker(args, inherit = false) {
  const result = spawnSync("docker", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (result.error) throw new Error("Docker is required to verify the Linux container.");
  if (result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr ?? "see command output"}`);
  return result.stdout?.trim() ?? "";
}
docker(["version", "--format", "{{.Server.Version}}"]);
// macOS Docker VMs share the home directory; the OS temporary directory may be unmounted.
const root = await mkdtemp(join(homedir(), ".eta-bot-container-"));
const name = `eta-bot-verification-${process.pid}-${Date.now()}`;
const image = `${name}:test`;
const data = `${name}-data`;
const workspace = `${name}-workspace`;
let reader;
try {
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      dataRoot: "/var/lib/eta-bot",
      host: "0.0.0.0",
      port: 8080,
      adminToken: "container-fixture-token",
      shutdownGraceMs: 0,
      projects: [{ key: "test", rootPath: "/workspaces/test" }],
      credentials: { anthropic: "ETA_BOT_CONTAINER_KEY" },
      runtime: { defaultThinkingLevel: "off" },
      discord: {
        enabled: false,
        tokenEnv: "UNUSED_DISCORD_TOKEN",
        channels: [{ guildId: "1", channelId: "10", projectKey: "test" }],
      },
    }),
  );
  docker(["build", "--tag", image, "--file", "apps/bot/Dockerfile", "."], true);
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--mount",
    `type=bind,source=${config},target=/etc/eta-bot/config.json,readonly`,
    "--mount",
    `source=${data},target=/var/lib/eta-bot`,
    "--mount",
    `source=${workspace},target=/workspaces/test`,
    "--env",
    "ETA_BOT_CONTAINER_KEY=offline-placeholder",
    "--publish",
    "127.0.0.1::8080",
    image,
  ]);
  docker(["exec", "--user", "0", name, "chown", "node:node", "/workspaces/test"]);
  const base = () => `http://${docker(["port", name, "8080/tcp"])}`;
  const ready = async () => {
    const url = base();
    const deadline = Date.now() + 10000;
    while (true) {
      if (
        await fetch(`${url}/readyz`)
          .then((response) => response.ok)
          .catch(() => false)
      )
        return url;
      if (Date.now() >= deadline) throw new Error("Linux container did not become ready.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  let url = await ready();
  assert.equal(docker(["exec", name, "id", "-u"]), "1000");
  docker(["exec", name, "test", "-w", "/workspaces/test"]);
  assert.match(docker(["exec", name, "git", "--version"]), /^git version/);
  assert.match(docker(["exec", name, "bash", "--version"]), /GNU bash/);
  docker([
    "exec",
    name,
    "node",
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict'; import { processImage } from './dist/runtime.mjs'; const image = await processImage(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'test.gif'); assert.equal(image.mimeType, 'image/png');`,
  ]);
  const headers = {
    authorization: "Bearer container-fixture-token",
    "content-type": "application/json",
  };
  const workspaces = await (await fetch(`${url}/v1/workspaces`, { headers })).json();
  const create = async () => {
    const response = await fetch(`${url}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: workspaces[0].id, requestId: "container-create" }),
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const thread = await create();
  reader = (await fetch(`${url}/v1/threads/${thread.id}/events`, { headers })).body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
  docker(["stop", "--time", "15", name]);
  assert.equal(docker(["inspect", "--format", "{{.State.ExitCode}}", name]), "0");
  await reader.cancel().catch(() => {});
  reader = undefined;
  docker(["start", name]);
  url = await ready();
  assert.equal((await create()).id, thread.id);
  console.log(
    "Linux container verified: tools, non-root persistent volumes, HTTP/SSE, shutdown, restart and bundled images.",
  );
} catch (error) {
  // Preserve startup and shutdown diagnostics before removing this verifier's container.
  spawnSync("docker", ["logs", name], { cwd: repository, stdio: "inherit" });
  throw error;
} finally {
  await reader?.cancel().catch(() => {});
  for (const args of [
    ["rm", "--force", name],
    ["volume", "rm", "--force", data, workspace],
    ["image", "rm", image],
  ]) {
    spawnSync("docker", args, { cwd: repository, stdio: "ignore" });
  }
  await rm(root, { recursive: true, force: true });
}
