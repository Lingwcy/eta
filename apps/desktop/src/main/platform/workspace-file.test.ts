import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_LINES,
  expandHome,
  readWorkspaceFilePreview,
  resolveWorkspaceFilePath,
} from "./workspace-file.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), "eta-workspace-file-"));
  tempDirs.push(dir);
  return dir;
}

test("resolves relative, absolute, and ~/ paths and rejects malformed or unrooted relative paths", () => {
  expect(expandHome("~/repo/file.ts", "/home/alice")).toBe("/home/alice/repo/file.ts");
  expect(resolveWorkspaceFilePath("src/app.ts", "/repo")).toBe(join("/repo", "src/app.ts"));
  expect(resolveWorkspaceFilePath("/etc/hosts")).toBe("/etc/hosts");
  expect(resolveWorkspaceFilePath("~/notes.md")).toBe(join(homedir(), "notes.md"));
  expect(() => resolveWorkspaceFilePath("src/app.ts")).toThrow();
  expect(() => resolveWorkspaceFilePath("   ", "/repo")).toThrow();
  expect(() => resolveWorkspaceFilePath("bad\0path", "/repo")).toThrow();
});

test("reads workspace files with canonical displayPath, rootName, and language detection", async () => {
  const root = await makeWorkspace();
  await mkdir(join(root, "src"), { recursive: true });
  const file = join(root, "src", "example.tsx");
  await writeFile(file, "export const n = 1;\r\nexport const m = 2;\r\n", "utf8");

  const result = await readWorkspaceFilePreview("src/example.tsx", root);
  expect(result).toMatchObject({
    status: "ready",
    displayPath: "src/example.tsx",
    language: "tsx",
    name: "example.tsx",
    content: "export const n = 1;\nexport const m = 2;\n",
    truncated: false,
    totalLines: 3,
  });
  if (result.status === "ready") {
    expect(result.rootName).toBeTruthy();
  }
});

test("bounds large files by bytes and lines and reports binary, directory, and missing states", async () => {
  const root = await makeWorkspace();
  await mkdir(join(root, "nested"), { recursive: true });

  const manyLines = Array.from(
    { length: WORKSPACE_FILE_PREVIEW_MAX_LINES + 50 },
    (_, i) => `L${i + 1}`,
  ).join("\n");
  await writeFile(join(root, "many.ts"), manyLines, "utf8");
  const lineCapped = await readWorkspaceFilePreview("many.ts", root);
  expect(lineCapped).toMatchObject({
    status: "ready",
    truncated: true,
    totalLines: WORKSPACE_FILE_PREVIEW_MAX_LINES,
  });

  const oversizedBytes = "a".repeat(100) + "\n";
  const repeated = oversizedBytes.repeat(
    Math.ceil(WORKSPACE_FILE_PREVIEW_MAX_BYTES / oversizedBytes.length) + 10,
  );
  await writeFile(join(root, "big.txt"), repeated, "utf8");
  const byteCapped = await readWorkspaceFilePreview("big.txt", root);
  expect(byteCapped.status).toBe("ready");
  if (byteCapped.status === "ready") {
    expect(byteCapped.truncated).toBe(true);
    expect(Buffer.byteLength(byteCapped.content, "utf8")).toBeLessThanOrEqual(
      WORKSPACE_FILE_PREVIEW_MAX_BYTES,
    );
  }

  await writeFile(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  expect(await readWorkspaceFilePreview("image.bin", root)).toMatchObject({
    status: "unavailable",
    reason: "binary",
  });

  expect(await readWorkspaceFilePreview("nested", root)).toMatchObject({
    status: "unavailable",
    reason: "directory",
  });

  expect(await readWorkspaceFilePreview("missing.ts", root)).toMatchObject({
    status: "unavailable",
    reason: "missing",
  });
});
