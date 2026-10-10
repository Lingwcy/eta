import { defineDoc } from "@eta/agent";
import type { SandboxMode } from "../../shared/sandbox.ts";
import { defaultSandboxMode } from "../../shared/sandbox.ts";

// Session scope makes the root and all delegates share the host's current permission boundary.
export const SandboxDoc = defineDoc<{ mode: SandboxMode; revision: number }>({
  kind: "eta.sandbox",
  version: 1,
  scope: "session",
  initial: () => ({ mode: defaultSandboxMode, revision: 0 }),
});
