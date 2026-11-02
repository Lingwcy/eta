import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";

it.each(["memory", "jsonl"])(
  "%s storage retains streamed suffixes within a bounded heap",
  async (backend) => {
    const directory = await mkdtemp(join(tmpdir(), "eta-stream-deltas-"));
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--experimental-strip-types",
          "--expose-gc",
          "--max-old-space-size=128",
          fileURLToPath(new URL("./delta-memory-worker.ts", import.meta.url)),
          backend,
          directory,
        ],
        { timeout: 25_000, maxBuffer: 16 * 1024 },
      );
      expect(result.stdout).toContain("streamed text remains intact within the heap budget");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
