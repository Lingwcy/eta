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
    (await readFile(entry, "utf8")) + "\nmodule.exports = { createDesktopApplication };\n",
    entry,
  );
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
  application = await compiled.exports.createDesktopApplication(isolated, workspace, data);
  const library = await application.library();
  assert.equal(library.projects.length, 1);
  assert.ok(library.models.length > 0, "Bundled model catalog must be available");
  assert.ok(library.providers.length > 0, "Bundled authentication providers must be available");
  await application.updateSettings({ defaultThinkingLevel: "low" });
  await application.close();
  application = await compiled.exports.createDesktopApplication(isolated, workspace, data);
  assert.equal((await application.library()).settings.defaultThinkingLevel, "low");
  assert.equal((await application.library()).projects[0].id, library.projects[0].id);
  console.log(
    "Packaged runtime verified: isolated startup, model catalog, authentication, persistence.",
  );
} finally {
  await application?.close();
  await rm(temporary, { recursive: true, force: true });
}
