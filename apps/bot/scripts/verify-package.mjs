import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { verifyCli } from "./verify-cli.mjs";
import { verifyDiscord } from "./verify-discord.mjs";

// Load only the compiled distribution outside the workspace and without a provider network.
const temporary = await mkdtemp(join(tmpdir(), "eta-bot-package-"));
const fetch = globalThis.fetch;
let application;
try {
  const isolated = join(temporary, "app");
  await cp(process.argv[2] ?? fileURLToPath(new URL("../dist/", import.meta.url)), isolated, {
    recursive: true,
  });
  globalThis.fetch = () => {
    throw new Error("Package verification must remain offline.");
  };
  const { createBotApplication, processImage, DiscordSdk } = await import(
    pathToFileURL(join(isolated, "runtime.mjs")).href
  );
  const image = await processImage(
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    "test.gif",
  );
  assert.equal(image.mimeType, "image/png");
  assert.ok(image.data.length > 0);
  const workspace = join(temporary, "workspaces", "test");
  await mkdir(workspace, { recursive: true });
  const config = {
    dataRoot: join(temporary, "data"),
    adminToken: "offline-admin-token",
    workspaceRoot: join(temporary, "workspaces"),
    projects: [{ key: "test", rootPath: workspace }],
    runtime: { defaultThinkingLevel: "off" },
  };
  application = await createBotApplication(config);
  const imported = await application.app.request("/v1/credentials/import", {
    method: "POST",
    headers: { authorization: "Bearer offline-admin-token", "content-type": "application/json" },
    body: JSON.stringify({
      credentials: { anthropic: { type: "api_key", key: "offline-placeholder" } },
    }),
  });
  assert.equal(imported.status, 200);
  assert.ok((await application.core.models()).length > 0);
  assert.equal((await application.app.request("/healthz")).status, 200);
  assert.equal((await application.app.request("/v1/projects")).status, 401);
  const workspaceId = [...application.workspaceProjects.keys()][0];
  const create = (app) =>
    app.app.request("/v1/threads", {
      method: "POST",
      headers: { authorization: "Bearer offline-admin-token", "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, requestId: "packaged-create" }),
    });
  const response = await create(application);
  assert.equal(response.status, 201);
  const thread = await response.json();
  assert.equal(thread.snapshot.sandbox.mode, "workspace-write");
  assert.equal(thread.snapshot.sandbox.available, true, thread.snapshot.sandbox.reason);
  await application.close();
  application = await createBotApplication(config);
  assert.equal((await (await create(application)).json()).id, thread.id);
  await application.close();
  await verifyCli(isolated, temporary, config, fetch);
  await verifyDiscord(DiscordSdk);
  console.log(
    "Bot distribution verified: isolated startup, HTTP, images, restart, CLI shutdown and real Discord SDK against a local Gateway/REST fixture.",
  );
} finally {
  await application?.close();
  globalThis.fetch = fetch;
  await rm(temporary, { recursive: true, force: true });
}
