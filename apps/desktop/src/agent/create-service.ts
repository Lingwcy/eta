import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readAgentCredentials } from "./agent-credentials.ts";
import { readAgentSettings } from "./agent-settings.ts";
import { MemoryHarnessService } from "./memory-harness.ts";

/** Load project environment values once; real process variables always take precedence. */
export async function createAgentService(root: string, cwd: string) {
  for (const name of [".env", ".env.local", "apps/desktop/.env", "apps/desktop/.env.local"]) {
    try {
      const values = parseEnv(await readFile(resolve(root, name), "utf8"));
      for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  return new MemoryHarnessService(
    builtinModels({ credentials: await readAgentCredentials() }),
    cwd,
    readAgentSettings,
  );
}
