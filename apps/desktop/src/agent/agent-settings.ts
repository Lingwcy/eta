import { LocalizedError } from "../shared/i18n/messages.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@eta/core/agent/protocol";
import type { AgentModel } from "@eta/core/agent/protocol";

export interface AgentSettings {
  defaultProvider?: AgentModel["provider"];
  defaultModel?: AgentModel["id"];
  defaultThinkingLevel?: ThinkingLevel;
}

const thinkingLevels = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Read legacy pi defaults for first-run import into desktop settings. */
export async function readAgentSettings(
  path = join(homedir(), ".pi", "agent", "settings.json"),
): Promise<AgentSettings> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error(`无法读取 ${path}`, { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} 不是有效的 JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalizedError("errors:agentsettings.mustBeAJsonObject", { value1: path });

  const fields = value as Record<string, unknown>;
  const settings: AgentSettings = {};
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    if (!(key in fields)) continue;
    const selected = fields[key];
    if (typeof selected !== "string" || !selected.trim())
      throw new LocalizedError("errors:agentsettings.inMustBeANonEmptyString", {
        value1: path,
        value2: key,
      });
    settings[key] = selected.trim();
  }
  if ("defaultThinkingLevel" in value) {
    const level = value.defaultThinkingLevel;
    if (typeof level !== "string" || !thinkingLevels.has(level as ThinkingLevel))
      throw new LocalizedError("errors:agentsettings.invalidDefaultthinkinglevelIn", {
        value1: path,
      });
    settings.defaultThinkingLevel = level as ThinkingLevel;
  }
  return settings;
}
