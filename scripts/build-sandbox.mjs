import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const output = resolve(process.argv[2]);
  await mkdir(output, { recursive: true });
  const mac = process.platform === "darwin";
  const source = fileURLToPath(
    new URL(
      `../packages/core/src/platform/sandbox/${mac ? "mac-cleanup" : "linux-launcher"}.c`,
      import.meta.url,
    ),
  );
  const result = spawnSync(
    mac ? "/usr/bin/clang" : "cc",
    [
      ...(mac ? ["-arch", "arm64", "-arch", "x86_64"] : []),
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      source,
      "-o",
      resolve(output, mac ? "sandbox-cleanup" : "sandbox-launcher"),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Native sandbox helper compilation failed");
}
