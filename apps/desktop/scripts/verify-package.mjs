import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Module } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise the compiled runtime outside the repository, with no workspace dependencies or user data.
const temporary = await mkdtemp(join(tmpdir(), "eta-package-"));
let application;
try {
  const isolated = join(temporary, "app");
  await cp(
    process.argv[2] ?? fileURLToPath(new URL("../dist/package/", import.meta.url)),
    isolated,
    {
      recursive: true,
    },
  );
  const entry = join(isolated, "dist/electron/main.cjs");
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
      "\nmodule.exports = { createDesktopApplication, processImage };\n",
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
    isolated,
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
  await application.updateSettings({ defaultThinkingLevel: "low" });
  await application.close();
  application = await compiled.exports.createDesktopApplication(
    isolated,
    workspace,
    data,
    undefined,
    compiled.exports.processImage,
  );
  assert.equal((await application.library()).settings.defaultThinkingLevel, "low");
  assert.equal((await application.library()).projects[0].id, library.projects[0].id);
  console.log(
    "Packaged runtime verified: isolated startup, model catalog, authentication, image decoding, persistence.",
  );
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
