import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "./protocol.ts";
import type { AgentModel } from "./protocol.ts";

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

/** Read defaults for each new session so existing sessions keep their configuration. */
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
    throw new Error(`${path} 必须是 JSON 对象`);

  const fields = value as Record<string, unknown>;
  const settings: AgentSettings = {};
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    if (!(key in fields)) continue;
    const selected = fields[key];
    if (typeof selected !== "string" || !selected.trim())
      throw new Error(`${path} 中的 ${key} 必须是非空字符串`);
    settings[key] = selected.trim();
  }
  if ("defaultThinkingLevel" in value) {
    const level = value.defaultThinkingLevel;
    if (typeof level !== "string" || !thinkingLevels.has(level as ThinkingLevel))
      throw new Error(`${path} 中的 defaultThinkingLevel 无效`);
    settings.defaultThinkingLevel = level as ThinkingLevel;
  }
  return settings;
}
