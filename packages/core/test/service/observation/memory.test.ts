import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

test("large snapshot reads and subscriptions fit a bounded heap without copying image strings", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--max-old-space-size=64",
      "--import",
      fileURLToPath(new URL("../threads/source-loader.ts", import.meta.url)),
      fileURLToPath(new URL("./memory-worker.ts", import.meta.url)),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  expect(result.stdout).toContain("remain detached within the heap budget");
}, 25_000);
