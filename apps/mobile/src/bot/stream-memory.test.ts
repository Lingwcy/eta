import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const run = promisify(execFile);

test.each([65536, 1])(
  "an 8 MiB SSE event fits a 64 MiB heap with %i-byte reads",
  async (step) => {
    const { stdout } = await run(
      process.execPath,
      [
        "--max-old-space-size=64",
        fileURLToPath(new URL("./fixtures/fragmented-event.mjs", import.meta.url)),
        String(step),
      ],
      { timeout: 60000, maxBuffer: 64 * 1024 },
    );
    expect(JSON.parse(stdout)).toEqual({
      delivered: 1,
      size: 8 * 1024 * 1024,
      step,
      locked: false,
    });
  },
  65000,
);
