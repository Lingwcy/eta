// @vitest-environment jsdom
import { expect, test } from "vite-plus/test";
import type { DiffFile } from "@eta/core/shared/diff";
import { buildDiffTree } from "./diff-file-tree";

function file(path: string, kind: DiffFile["kind"] = "modified"): DiffFile {
  return { id: path, path, kind, staged: true, unstaged: true };
}

test("compacts directory-only chains and groups directories before basename-sorted files", () => {
  const files = [
    file("apps/docs/scripts/generate.ts"),
    file("apps/docs/app/(diffs)/_home/mockData.ts"),
    file("apps/docs/app/(diffs)/_home/AgentUi.tsx"),
    file("apps/docs/app/(diffs)/_home/agent-ui.css", "added"),
  ];
  expect(buildDiffTree(files)).toMatchObject([
    {
      kind: "directory",
      name: "apps/docs",
      path: "apps/docs",
      children: [
        {
          kind: "directory",
          name: "app/(diffs)/_home",
          children: [
            { kind: "file", name: "agent-ui.css", file: { path: files[3]!.path, kind: "added" } },
            { kind: "file", name: "AgentUi.tsx" },
            { kind: "file", name: "mockData.ts" },
          ],
        },
        { kind: "directory", name: "scripts", children: [{ kind: "file", name: "generate.ts" }] },
      ],
    },
  ]);
});

test("keeps a deleted file alongside the new directory that replaces it", () => {
  const removed = file("config", "deleted");
  const added = file("config/new.ts", "untracked");
  expect(buildDiffTree([removed, added])).toEqual([
    {
      kind: "directory",
      name: "config",
      path: "config",
      children: [{ kind: "file", name: "new.ts", file: added }],
    },
    { kind: "file", name: "config", file: removed },
  ]);
});

test("does not compress past a file and preserves full identity for duplicate basenames", () => {
  const root = file("src/example.ts");
  const nested = file("src/nested/example.ts");
  expect(buildDiffTree([root, nested])).toEqual([
    {
      kind: "directory",
      name: "src",
      path: "src",
      children: [
        {
          kind: "directory",
          name: "nested",
          path: "src/nested",
          children: [{ kind: "file", name: "example.ts", file: nested }],
        },
        { kind: "file", name: "example.ts", file: root },
      ],
    },
  ]);
});

test("handles object-prototype keys, Unicode and literal whitespace without mutating input", () => {
  const original = Object.freeze([
    file('__proto__/constructor/引号".ts'),
    file("toString/line\nname.ts"),
  ]);
  const tree = buildDiffTree(original);
  expect(tree).toEqual([
    {
      kind: "directory",
      name: "__proto__/constructor",
      path: "__proto__/constructor",
      children: [{ kind: "file", name: '引号".ts', file: original[0] }],
    },
    {
      kind: "directory",
      name: "toString",
      path: "toString",
      children: [{ kind: "file", name: "line\nname.ts", file: original[1] }],
    },
  ]);
  expect(original.map((entry) => entry.path)).toEqual([
    '__proto__/constructor/引号".ts',
    "toString/line\nname.ts",
  ]);
});
