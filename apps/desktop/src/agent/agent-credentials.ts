import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Credential } from "@earendil-works/pi-ai";

/** Import pi credentials at startup; harness auth updates stay in memory. */
export async function readAgentCredentials(path = join(homedir(), ".pi", "agent", "auth.json")) {
  const store = new InMemoryCredentialStore();
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return store;
    throw new Error(`无法读取 ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // JSON parser errors may quote the file's secret contents.
    throw new Error(`${path} 不是有效的 JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} 必须是 JSON 对象`);
  for (const [provider, credential] of Object.entries(parsed)) {
    if (!isCredential(credential)) throw new Error(`${path} 中 ${provider} 的认证格式无效`);
    await store.modify(provider, async () => credential);
  }
  return store;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  if (value.type === "api_key") {
    const validKey =
      value.key === undefined || (typeof value.key === "string" && !!value.key.trim());
    const validEnv =
      value.env === undefined ||
      (isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
    return validKey && validEnv && (value.key !== undefined || value.env !== undefined);
  }
  return (
    value.type === "oauth" &&
    typeof value.refresh === "string" &&
    !!value.refresh &&
    typeof value.access === "string" &&
    !!value.access &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}
