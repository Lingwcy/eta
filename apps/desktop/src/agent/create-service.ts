import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readAgentCredentials } from "./agent-credentials.ts";
import { readAgentSettings } from "./agent-settings.ts";
import { MemoryHarnessService } from "./memory-harness.ts";
import { loadProjectEnvironment } from "../main/environment.ts";

/** In-memory harness retained only as a lightweight test/demo adapter. */
export async function createAgentService(root: string, cwd: string) {
  await loadProjectEnvironment(root);
  return new MemoryHarnessService(
    builtinModels({ credentials: await readAgentCredentials() }),
    cwd,
    readAgentSettings,
  );
}
