import { globSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Compile both slices here; the host stages and signs the resulting helper. */
export async function buildNative(directory) {
  if (process.platform !== "darwin") return;
  const root = resolve(directory);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(
    new URL("../native/THIRD_PARTY_NOTICES.txt", import.meta.url),
    join(root, "THIRD_PARTY_NOTICES.txt"),
  );
  const sourceRoot = fileURLToPath(new URL("../native/", import.meta.url));
  const sources = globSync("*.swift", { cwd: sourceRoot })
    .sort()
    .map((name) => join(sourceRoot, name));
  const architectures = ["arm64", "x86_64"];
  for (const arch of architectures)
    execFileSync(
      "xcrun",
      [
        "swiftc",
        ...sources,
        "-O",
        "-target",
        `${arch}-apple-macos13.0`,
        "-framework",
        "AppKit",
        "-framework",
        "ApplicationServices",
        "-framework",
        "ScreenCaptureKit",
        "-o",
        join(root, `accessibility-${arch}`),
      ],
      { stdio: "inherit" },
    );
  execFileSync("lipo", [
    "-create",
    ...architectures.map((arch) => join(root, `accessibility-${arch}`)),
    "-output",
    join(root, "eta-accessibility"),
  ]);
  for (const arch of architectures) await rm(join(root, `accessibility-${arch}`));
}
