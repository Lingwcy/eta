import type { CatalogState } from "./catalog.ts";
import type { AgentModel } from "../agent/protocol.ts";
import type { RuntimeSettings } from "./runtime-settings.ts";
import type { SandboxMode } from "./sandbox.ts";

/** Hosts exchange this catalog; runtime handles and credentials stay on their own host. */
export interface BotLibrary extends CatalogState {
  allowedSandboxModes?: readonly SandboxMode[];
  credentials?: readonly { providerId: string; type: "api_key" | "oauth" }[];
  workspaceRoot?: string;
  models: readonly AgentModel[];
  settings: RuntimeSettings;
}
