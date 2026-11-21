import { expect, test, vi } from "vite-plus/test";
import { buildEditorArgs, detectInstalledEditors, openFileWithEditor } from "./external-editors.ts";

test("detects installed editors in deterministic priority order across app bundles and PATH", async () => {
  const existing = new Set(["/Applications/Cursor.app", "/usr/local/bin/code", "/opt/bin/zed"]);
  const editors = await detectInstalledEditors({
    platform: "darwin",
    home: "/Users/tester",
    env: { PATH: "/usr/local/bin:/opt/bin" },
    exists: async (target) => existing.has(target),
  });
  expect(editors).toEqual([
    { id: "vscode", name: "Visual Studio Code" },
    { id: "cursor", name: "Cursor" },
    { id: "zed", name: "Zed" },
  ]);
});

test("formats --goto and colon line/column CLI arguments accurately", () => {
  expect(buildEditorArgs({ goto: "--goto" }, "/repo/a.ts", 42, 8)).toEqual([
    "--goto",
    "/repo/a.ts:42:8",
  ]);
  expect(buildEditorArgs({ goto: "--goto" }, "/repo/a.ts", 10)).toEqual([
    "--goto",
    "/repo/a.ts:10",
  ]);
  expect(buildEditorArgs({ goto: "colon" }, "/repo/a.ts", 15, 2)).toEqual(["/repo/a.ts:15:2"]);
  expect(buildEditorArgs({ goto: "--goto" }, "/repo/a.ts")).toEqual(["/repo/a.ts"]);
});

test("opens files with CLI when present, falls back to macOS open -a, and rejects prototype keys", async () => {
  const spawnDetached = vi.fn(async () => {});
  const exec = vi.fn(async () => ({}));

  await openFileWithEditor("/repo/main.ts", "vscode", 12, 4, {
    platform: "darwin",
    env: { PATH: "/usr/local/bin" },
    exists: async (target) => target === "/usr/local/bin/code",
    spawnDetached,
    exec,
  });
  expect(spawnDetached).toHaveBeenCalledWith("/usr/local/bin/code", [
    "--goto",
    "/repo/main.ts:12:4",
  ]);
  expect(exec).not.toHaveBeenCalled();

  spawnDetached.mockClear();
  await openFileWithEditor("/repo/main.ts", "cursor", 12, 4, {
    platform: "darwin",
    env: { PATH: "" },
    home: "/Users/tester",
    exists: async (target) => target === "/Applications/Cursor.app",
    spawnDetached,
    exec,
  });
  expect(exec).toHaveBeenCalledWith("/usr/bin/open", [
    "-a",
    "/Applications/Cursor.app",
    "/repo/main.ts",
  ]);
  expect(spawnDetached).not.toHaveBeenCalled();

  for (const invalidId of ["constructor", "__proto__", "toString", "missing-editor"]) {
    await expect(
      openFileWithEditor("/repo/main.ts", invalidId, undefined, undefined, {
        platform: "darwin",
        exists: async () => true,
      }),
    ).rejects.toThrow();
  }
});
