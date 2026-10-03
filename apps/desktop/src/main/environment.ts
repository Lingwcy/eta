import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

/** Import local development configuration once; real process variables take precedence. */
export async function loadProjectEnvironment(root: string): Promise<void> {
  for (const name of [".env", ".env.local", "apps/desktop/.env", "apps/desktop/.env.local"]) {
    try {
      const values = parseEnv(await readFile(resolve(root, name), "utf8"));
      for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}
