import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load an isolated published native package without invoking any desktop operation.
const entry = process.argv[2];
assert.ok(
  entry,
  "Usage: node scripts/verify-computer-native.mjs <staged computer-native directory>",
);
const isolated = await mkdtemp(join(tmpdir(), "eta-computer-package-"));
try {
  await cp(resolve(entry), join(isolated, "app"), { recursive: true });
  assert.deepEqual(
    JSON.parse(
      execFileSync(join(isolated, "app", "eta-accessibility"), ["--self-test"], {
        encoding: "utf8",
        timeout: 10_000,
      }),
    ),
    { protocol: 1, accessibility: true, backgroundInput: true },
  );
  const architectures = execFileSync(
    "lipo",
    ["-archs", join(isolated, "app", "eta-accessibility")],
    { encoding: "utf8" },
  );
  assert.ok(architectures.includes("arm64") && architectures.includes("x86_64"));
  console.log(
    `Verified isolated native helper (${architectures.trim()}); no Node native dependency.`,
  );
} finally {
  await rm(isolated, { recursive: true, force: true });
}
