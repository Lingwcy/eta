import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Module, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCodemode } from "../../../scripts/verify-codemode.mjs";

// Exercise the compiled runtime outside the repository, with no workspace dependencies or user data.
const temporary = await mkdtemp(join(tmpdir(), "eta-package-"));
let application;
let remove = rm;
try {
  const isolated = join(temporary, "app");
  const source = process.argv[2] ?? fileURLToPath(new URL("../dist/package/", import.meta.url));
  const asar = source.endsWith(".asar");
  if (asar) {
    await mkdir(isolated);
    // Electron's normal fs treats an ASAR as a directory; copy the archive bytes unchanged.
    const original = createRequire(import.meta.url)("original-fs");
    remove = original.promises.rm;
    await original.promises.copyFile(source, join(isolated, "app.asar"));
    await cp(`${source}.unpacked`, join(isolated, "app.asar.unpacked"), { recursive: true });
  } else {
    await cp(source, isolated, { recursive: true });
  }
  const appRoot = asar ? join(isolated, "app.asar") : isolated;
  const entry = join(appRoot, "dist/electron/main.cjs");
  const compiled = new Module(entry);
  compiled.filename = entry;
  const electron = {
    app: { requestSingleInstanceLock: () => false, quit() {} },
    ipcMain: { on() {}, handle() {} },
  };
  const require = compiled.require.bind(compiled);
  compiled.require = (id) => (id === "electron" ? electron : require(id));
  compiled._compile(
    (await readFile(entry, "utf8")) +
      "\nmodule.exports = { createDesktopApplication, processImage, RuntimeCodemodeSandbox };\n",
    entry,
  );
  const image = await compiled.exports.processImage(
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    "test.gif",
  );
  assert.equal(image.mimeType, "image/png", "Bundled codec must convert image attachments");
  assert.ok(image.data.length > 0);
  const data = join(temporary, "data");
  const workspace = join(temporary, "workspace");
  await mkdir(data);
  await mkdir(workspace);
  await verifyCodemode(
    compiled.exports.RuntimeCodemodeSandbox,
    join(isolated, asar ? "app.asar.unpacked/dist/electron" : "dist/electron"),
    workspace,
    "cjs",
  );
  await writeFile(
    join(data, "credentials.json"),
    JSON.stringify({
      version: 1,
      credentials: { anthropic: { type: "api_key", key: "eta-offline-packaging-test" } },
    }),
  );
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({ version: 1, settings: { defaultThinkingLevel: "off" } }),
  );
  application = await compiled.exports.createDesktopApplication(
    appRoot,
    workspace,
    data,
    undefined,
    compiled.exports.processImage,
  );
  await writeFile(
    join(workspace, "image.gif"),
    Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  );
  assert.equal(
    (await application.prepareImage({ path: "image.gif" }, workspace)).mimeType,
    "image/png",
  );
  const library = await application.library();
  assert.equal(library.projects.length, 1);
  assert.ok(library.models.length > 0, "Bundled model catalog must be available");
  assert.ok(library.providers.length > 0, "Bundled authentication providers must be available");
  const workspaceId = library.workspaces[0].id;
  const thread = await application.createThread(workspaceId);
  assert.equal(thread.snapshot.sandbox.mode, "workspace-write");
  if (process.platform !== "win32")
    assert.equal(thread.snapshot.sandbox.available, true, thread.snapshot.sandbox.reason);
  else assert.equal(thread.snapshot.sandbox.available, false);
  const scheduled = await application.writeSchedule({
    threadId: thread.id,
    requestId: "packaged-schedule",
    change: {
      action: "create",
      name: "Packaged plan",
      prompt: "Review repository",
      rule: { type: "once", at: Date.now() + 3600000 },
    },
  });
  assert.equal(scheduled.state, "applied");
  const proposed = await application.proposeSchedule({
    threadId: thread.id,
    requestId: "packaged-proposal",
    sourceIdentity: "root:packaging",
    change: {
      action: "update",
      scheduleId: scheduled.scheduleId,
      expectedRevision: 1,
      patch: { prompt: "Updated review" },
    },
  });
  let snapshot = await application.scheduleSnapshot();
  const proposal = snapshot.snapshots[0].data.proposals.find(
    (value) => value.id === proposed.proposalId,
  );
  assert.equal(proposal.state, "pending");
  assert.equal(
    (
      await application.decideSchedule(
        {
          proposalId: proposal.id,
          contentFingerprint: proposal.contentFingerprint,
          requestId: "packaged-approve",
        },
        true,
      )
    ).state,
    "applied",
  );
  await application.updateSettings({ defaultThinkingLevel: "low" });
  await application.close();
  application = await compiled.exports.createDesktopApplication(
    appRoot,
    workspace,
    data,
    undefined,
    compiled.exports.processImage,
  );
  assert.equal((await application.library()).settings.defaultThinkingLevel, "low");
  const restored = (await application.scheduleSnapshot()).snapshots[0].data.schedules.find(
    (value) => value.id === scheduled.scheduleId,
  );
  assert.equal(restored.prompt, "Updated review");
  assert.equal(restored.revision, 2);
  assert.equal(
    (
      await application.writeSchedule({
        threadId: thread.id,
        requestId: "packaged-pause",
        change: { action: "pause", scheduleId: restored.id, expectedRevision: restored.revision },
      })
    ).state,
    "applied",
  );
  assert.equal((await application.library()).projects[0].id, library.projects[0].id);
  console.log(
    "Packaged runtime verified: isolated Code mode worker/WASM/tool bridge and cancellation, startup, model catalog, authentication, image decoding, persistence, scheduled proposals and durable plans.",
  );
} finally {
  await application?.close();
  await remove(temporary, { recursive: true, force: true });
}
