import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DesktopServiceError } from "./errors.ts";

/** Missing files are defaults; corrupt files are never silently overwritten. */
export async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new DesktopServiceError({ code: "StorageUnavailable", message: `无法读取 ${path}` });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DesktopServiceError({ code: "StorageCorrupt", message: `${path} 不是有效的 JSON` });
  }
}

/** Replace in the same directory; publish in-memory state only after this succeeds. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
