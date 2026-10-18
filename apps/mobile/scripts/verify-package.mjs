import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(manifest.name, "eta-mobile");
for (const name of Object.keys(manifest.dependencies)) {
  assert(!name.startsWith("@eta/"), `Mobile must communicate over HTTP, found dependency ${name}`);
}
for (const platform of ["ios", "android"]) {
  const directory = join(root, "dist/_expo/static/js", platform);
  const files = await readdir(directory);
  const maps = files.filter((name) => name.endsWith(".map"));
  assert(maps.length > 0, `Missing ${platform} bundle/source map`);
  for (const map of maps) {
    const value = JSON.parse(await readFile(join(directory, map), "utf8"));
    for (const source of value.sources) {
      assert(
        !/(?:packages\/(?:agent|core)\/|apps\/desktop\/|@eta\/(?:agent|core))/.test(
          source.replaceAll("\\", "/"),
        ),
        `Forbidden runtime source in ${platform}: ${source}`,
      );
    }
  }
  console.log(`${platform}: exported bundle has no Eta agent, core or desktop sources`);
}
const config = JSON.parse(await readFile(join(root, "app.json"), "utf8")).expo;
assert.equal(config.name, "Eta");
assert.equal(config.ios.bundleIdentifier, "com.eta.mobile");
assert.equal(config.android.package, "com.eta.mobile");
assert.equal(config.scheme, "eta-mobile");
assert.equal(config.android.adaptiveIcon.backgroundColor, "#171717");
for (const path of new Set([config.icon, config.android.adaptiveIcon.foregroundImage])) {
  assert.equal(typeof path, "string", "Missing app icon");
  const icon = await readFile(join(root, path));
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Icon must be PNG");
  assert.equal(icon.readUInt32BE(16), 1024, "Icon must be 1024px wide");
  assert.equal(icon.readUInt32BE(20), 1024, "Icon must be 1024px tall");
}
assert(!config.android.permissions.includes("android.permission.RECORD_AUDIO"));
assert(config.android.blockedPermissions.includes("android.permission.RECORD_AUDIO"));
console.log("eta-mobile package verified");
