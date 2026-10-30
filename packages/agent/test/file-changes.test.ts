import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { applyPatch } from "diff";
import { afterEach, expect, test } from "vitest";
import type { ToolExecutionApi } from "../src/harness/types.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";
import { FileError, err } from "../src/env/index.ts";
import { createEditTool, createWriteTool, type FileChangeContent, type FileChangeRecorder } from "../src/tools/index.ts";
import { FILE_CHANGE_MAX_BYTES } from "../src/tools/file-change.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "eta-file-change-tools-"));
  directories.push(directory);
  const env = new NodeExecutionEnv({ cwd: directory });
  const records: FileChangeContent[] = [];
  const progress: JsonValue[] = [];
  const recorder: FileChangeRecorder = async (candidate, path, api) => {
    records.push(candidate);
    const reference = { id: String(api.taskId), path, status: "uncertain" as const };
    return { reference, applied: async () => ({ ...reference, status: candidate.status === "ready" ? candidate.noChange ? "no-change" : "recorded" : candidate.reason === "too-large" ? "too-large" : "unavailable" }) };
  };
  let id = 0;
  const api = () => ({ taskId: ++id, conversationId: 1, callId: `call-${id}`, env, details: async (value: JsonValue) => { progress.push(value); } }) as unknown as ToolExecutionApi;
  return { directory, env, records, progress, recorder, api };
}

test("edit history uses actual BOM/CRLF content rather than its normalized matching base", async () => {
  const f = await fixture();
  const before = "\uFEFFconst a = 1;\r\nunchanged\r\n";
  await writeFile(join(f.directory, "a.ts"), before);
  const result = await createEditTool({ fileChanges: f.recorder }).execute({ path: "a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }, f.api(), BACKGROUND_CONTEXT);
  const record = f.records[0]!;
  expect(record.status).toBe("ready");
  if (record.status !== "ready") throw new Error("missing patch");
  expect(applyPatch(before, record.patch)).toBe(await readFile(join(f.directory, "a.ts"), "utf8"));
  expect(result.details).toEqual({ fileChange: { id: "1", path: "a.ts", status: "recorded" } });
  expect(JSON.stringify(result.details)).not.toContain("patch");
});

test("write records creation, overwrite and no-op as different operations", async () => {
  const f = await fixture();
  const tool = createWriteTool({ fileChanges: f.recorder });
  for (const content of ["first\n", "second\n", "second\n"]) await tool.execute({ path: "new.ts", content }, f.api(), BACKGROUND_CONTEXT);
  const [created, overwritten, noop] = f.records;
  if (created?.status !== "ready" || overwritten?.status !== "ready" || noop?.status !== "ready") throw new Error("missing patches");
  expect(created.patch).toContain("--- /dev/null");
  expect(applyPatch("", created.patch)).toBe("first\n");
  expect(applyPatch("first\n", overwritten.patch)).toBe("second\n");
  expect(noop.noChange).toBe(true);
  expect(f.progress.at(-1)).toEqual({ fileChange: { id: "3", path: "new.ts", status: "no-change" } });
});

test("concurrent writes freeze successive baselines inside the file queue", async () => {
  const f = await fixture();
  await writeFile(join(f.directory, "a.ts"), "original\n");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const recorder: FileChangeRecorder = async (...args) => {
    const result = await f.recorder(...args);
    if (f.records.length === 1) { entered(); await gate; }
    return result;
  };
  const tool = createWriteTool({ fileChanges: recorder });
  const first = tool.execute({ path: "a.ts", content: "A\n" }, f.api(), BACKGROUND_CONTEXT);
  try {
    await started;
    const second = tool.execute({ path: "a.ts", content: "B\n" }, f.api(), BACKGROUND_CONTEXT);
    release();
    await Promise.all([first, second]);
  } finally { release(); await first; }
  const [a, b] = f.records;
  if (a?.status !== "ready" || b?.status !== "ready") throw new Error("missing patches");
  expect(applyPatch("original\n", a.patch)).toBe("A\n");
  expect(applyPatch("A\n", b.patch)).toBe("B\n");
});

test.each(["binary", "too-large", "unreadable"])("unsupported %s baseline does not remove write capability", async (kind) => {
  const f = await fixture();
  const path = join(f.directory, "a.ts");
  await writeFile(path, kind === "binary" ? new Uint8Array([0xff, 0x00]) : kind === "too-large" ? "a".repeat(FILE_CHANGE_MAX_BYTES + 1) : "old");
  if (kind === "unreadable") f.env.openBinaryReader = async () => err(new FileError("permission_denied", "no read permission"));
  const result = await createWriteTool({ fileChanges: f.recorder }).execute({ path: "a.ts", content: "replacement" }, f.api(), BACKGROUND_CONTEXT);
  expect(await readFile(path, "utf8")).toBe("replacement");
  expect(f.records[0]).toEqual({ status: "unavailable", reason: kind === "unreadable" ? "not-recorded" : kind });
  expect(result.details?.fileChange?.status).toBe(kind === "too-large" ? "too-large" : "unavailable");
});

test("completion storage failure does not fail or repeat an applied write", async () => {
  const f = await fixture();
  const recorder: FileChangeRecorder = async (...args) => ({ ...(await f.recorder(...args)), applied: async () => { throw new Error("storage full"); } });
  const result = await createWriteTool({ fileChanges: recorder }).execute({ path: "a.ts", content: "written" }, f.api(), BACKGROUND_CONTEXT);
  expect(await readFile(join(f.directory, "a.ts"), "utf8")).toBe("written");
  expect(result.details?.fileChange?.status).toBe("uncertain");
});

test("cancellation immediately after write retains confirmed history progress", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const original = f.env.writeFile.bind(f.env);
  f.env.writeFile = async (...args) => { const result = await original(...args); controller.abort(); return result; };
  await expect(createWriteTool({ fileChanges: f.recorder }).execute({ path: "a.ts", content: "written" }, f.api(), withAbortSignal(controller.signal, BACKGROUND_CONTEXT))).rejects.toThrow("Operation aborted");
  expect(await readFile(join(f.directory, "a.ts"), "utf8")).toBe("written");
  expect(f.progress.at(-1)).toEqual({ fileChange: { id: "1", path: "a.ts", status: "recorded" } });
});
