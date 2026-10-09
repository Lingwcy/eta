import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

/** Verify the actual entry point can release SSE and incomplete request connections on SIGTERM. */
export async function verifyCli(isolated, temporary, config, fetch) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const path = join(temporary, "cli-config.json");
  await writeFile(
    path,
    JSON.stringify({
      ...config,
      dataRoot: join(temporary, "cli-data"),
      host: "127.0.0.1",
      port,
      shutdownGraceMs: 0,
      discord: {
        enabled: false,
        tokenEnv: "UNSET_OFFLINE_DISCORD_TOKEN",
        channels: [{ guildId: "1", channelId: "10", projectKey: "test" }],
      },
    }),
  );
  const child = spawn(process.execPath, [join(isolated, "main.mjs"), path], {
    cwd: isolated,
    env: { ...process.env, ETA_BOT_CONFIG: path },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const ended = once(child, "exit", { signal: AbortSignal.timeout(8000) });
  // Install a handler immediately so a startup error cannot produce an unhandled rejection.
  void ended.catch(() => {});
  let socket;
  let reader;
  try {
    const base = `http://127.0.0.1:${port}`;
    const headers = {
      authorization: `Bearer ${config.adminToken}`,
      "content-type": "application/json",
    };
    const deadline = Date.now() + 5000;
    while (true) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Compiled CLI exited before readiness: ${stderr}`);
      const healthy = await fetch(`${base}/readyz`)
        .then((response) => response.ok)
        .catch(() => false);
      if (healthy) break;
      if (Date.now() >= deadline) throw new Error(`Compiled CLI did not become ready: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const workspaces = await (await fetch(`${base}/v1/workspaces`, { headers })).json();
    const response = await fetch(`${base}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: workspaces[0].id, requestId: "cli-create" }),
    });
    assert.equal(response.status, 201);
    const thread = await response.json();
    const events = await fetch(`${base}/v1/threads/${thread.id}/events`, { headers });
    reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
    socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(
      `POST /v1/threads/${thread.id}/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${config.adminToken}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    child.kill("SIGTERM");
    const [code] = await ended;
    assert.equal(code, 0, `Compiled CLI must close active network connections: ${stderr}`);
  } finally {
    socket?.destroy();
    await reader?.cancel().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await ended.catch(() => {});
    }
  }
}
