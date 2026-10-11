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
assert(!config.android.permissions.includes("android.permission.RECORD_AUDIO"));
assert(config.android.blockedPermissions.includes("android.permission.RECORD_AUDIO"));
console.log("eta-mobile package verified");
