import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "eta-native-policy-"));
  try {
    const binary = join(directory, "test");
    execFileSync(
      "xcrun",
      [
        "swiftc",
        fileURLToPath(new URL("../native/DesktopSession.swift", import.meta.url)),
        fileURLToPath(new URL("../native/DragTrajectory.swift", import.meta.url)),
        fileURLToPath(new URL("../native/FocusRecovery.swift", import.meta.url)),
        fileURLToPath(new URL("../native/InputOwnership.swift", import.meta.url)),
        fileURLToPath(new URL("../native/WindowIdentity.swift", import.meta.url)),
        fileURLToPath(new URL("../native/TargetSelection.swift", import.meta.url)),
        fileURLToPath(new URL("../native/KeyboardTarget.swift", import.meta.url)),
        fileURLToPath(new URL("../native/PublishedWindows.swift", import.meta.url)),
        fileURLToPath(new URL("../native/WindowOrderRecovery.swift", import.meta.url)),
        fileURLToPath(new URL("../native/KeyboardEventRouting.swift", import.meta.url)),
        fileURLToPath(new URL("../native/PointerVisibility.swift", import.meta.url)),
        fileURLToPath(new URL("../test/native/main.swift", import.meta.url)),
        "-framework",
        "ApplicationServices",
        "-o",
        binary,
      ],
      { stdio: "inherit" },
    );
    execFileSync(binary, [], { stdio: "inherit", timeout: 10_000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
