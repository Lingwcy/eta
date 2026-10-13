import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

// The repository the desktop update channel must belong to. Changing
// either value is a transfer of the update channel to another owner,
// not a routine edit: every installed client follows these pointers,
// so it requires an explicit maintainer decision.
const expectedOwner = "Lingwcy";
const expectedRepo = "eta";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function publishTarget() {
  const config = readFileSync(join(root, "apps/desktop/electron-builder.config.cjs"), "utf8");
  const match = /publish:\s*\{\s*provider:\s*"github",\s*owner:\s*"([^"]+)",\s*repo:\s*"([^"]+)"/.exec(
    config,
  );
  assert.ok(match, "electron-builder config must declare a GitHub publish target");
  return { owner: match[1]!, repo: match[2]! };
}

function releaseUrlTarget() {
  const updater = readFileSync(join(root, "apps/desktop/src/main/platform/updater.ts"), "utf8");
  const match = /releaseUrl\s*=\s*"https:\/\/github\.com\/([^/"]+)\/([^/"]+)\/releases\/latest"/.exec(
    updater,
  );
  assert.ok(match, "updater must declare a releases URL");
  return { owner: match[1]!, repo: match[2]! };
}

test("desktop update source belongs to the repository owner", () => {
  // Regression guard for PR #1 (e9508a1), which pointed both targets at
  // a contributor's personal repository until PR #3 (6599b6f) fixed it.
  // This test fails on that commit's files and passes on current main.
  assert.deepEqual(publishTarget(), { owner: expectedOwner, repo: expectedRepo });
  assert.deepEqual(releaseUrlTarget(), { owner: expectedOwner, repo: expectedRepo });
});
