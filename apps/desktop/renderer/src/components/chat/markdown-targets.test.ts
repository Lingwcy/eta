import { expect, test } from "vite-plus/test";
import {
  classifyMarkdownLink,
  formatFileLineSuffix,
  markdownUrlTransform,
  parseFileReference,
  parseInlineCodeFileReference,
} from "./markdown-targets";

test("parses file:// URLs, local paths, and line/column/range locators", () => {
  expect(
    parseFileReference("file:///Users/wcy/Desktop/software/eta/apps/desktop/src/main.ts#L12-L24"),
  ).toEqual({
    path: "/Users/wcy/Desktop/software/eta/apps/desktop/src/main.ts",
    name: "main.ts",
    line: 12,
    endLine: 24,
  });

  expect(parseFileReference("file:///Users/wcy/My%20Repo/src/index.ts:42:8")).toEqual({
    path: "/Users/wcy/My Repo/src/index.ts",
    name: "index.ts",
    line: 42,
    column: 8,
  });

  expect(parseFileReference("file:///C:/repo/src/app.tsx#L10C3")).toEqual({
    path: "C:/repo/src/app.tsx",
    name: "app.tsx",
    line: 10,
    column: 3,
  });

  expect(parseFileReference("./src/app.ts:15-20")).toEqual({
    path: "./src/app.ts",
    name: "app.ts",
    line: 15,
    endLine: 20,
  });

  expect(formatFileLineSuffix({ line: 10 })).toBe(":10");
  expect(formatFileLineSuffix({ line: 10, endLine: 20 })).toBe(":10-20");
  expect(formatFileLineSuffix({})).toBe("");
});

test("classifies Markdown links into file, GitHub PR/Issue, web, mailto, and unsafe targets", () => {
  expect(classifyMarkdownLink("file:///repo/src/app.ts#L5")).toEqual({
    kind: "file",
    file: { path: "/repo/src/app.ts", name: "app.ts", line: 5 },
  });

  expect(classifyMarkdownLink("https://github.com/Lingwcy/eta/pull/648")).toEqual({
    kind: "github-pr",
    url: "https://github.com/Lingwcy/eta/pull/648",
    owner: "Lingwcy",
    repo: "eta",
    number: 648,
    label: "eta#648",
  });

  expect(
    classifyMarkdownLink("https://github.com/Lingwcy/eta/pull/648/files#diff-1"),
  ).toMatchObject({
    kind: "github-pr",
    label: "eta#648",
  });

  expect(classifyMarkdownLink("https://github.com/Lingwcy/eta/issues/42")).toEqual({
    kind: "github-issue",
    url: "https://github.com/Lingwcy/eta/issues/42",
    owner: "Lingwcy",
    repo: "eta",
    number: 42,
    label: "eta#42",
  });

  expect(classifyMarkdownLink("https://viteplus.dev/guide/")).toEqual({
    kind: "web",
    url: "https://viteplus.dev/guide/",
    host: "viteplus.dev",
  });

  expect(classifyMarkdownLink("mailto:hello@example.com")).toEqual({
    kind: "external",
    url: "mailto:hello@example.com",
  });

  for (const unsafe of [undefined, "", "#heading", "javascript:alert(1)", "data:text/html,test"]) {
    expect(classifyMarkdownLink(unsafe)).toEqual({ kind: "unsafe" });
  }
});

test("markdownUrlTransform preserves file:// and relative links while blocking unsafe schemes", () => {
  expect(markdownUrlTransform("file:///repo/src/app.ts")).toBe("file:///repo/src/app.ts");
  expect(markdownUrlTransform("./src/app.ts")).toBe("./src/app.ts");
  expect(markdownUrlTransform("https://github.com/Lingwcy/eta/pull/648")).toBe(
    "https://github.com/Lingwcy/eta/pull/648",
  );
  expect(markdownUrlTransform("javascript:alert(1)")).toBe("");
  expect(markdownUrlTransform("data:text/html,hi")).toBe("");
});

test("parseInlineCodeFileReference matches workspace file paths and rejects branches, CSS utilities, and identifiers", () => {
  expect(parseInlineCodeFileReference("apps/desktop/src/main.ts")).toEqual({
    path: "apps/desktop/src/main.ts",
    name: "main.ts",
  });
  expect(parseInlineCodeFileReference("apps/desktop/src/main.ts:42:8")).toEqual({
    path: "apps/desktop/src/main.ts",
    name: "main.ts",
    line: 42,
    column: 8,
  });
  expect(parseInlineCodeFileReference("package.json")).toEqual({
    path: "package.json",
    name: "package.json",
  });
  expect(parseInlineCodeFileReference("~/notes/todo.md")).toEqual({
    path: "~/notes/todo.md",
    name: "todo.md",
  });
  expect(parseInlineCodeFileReference("docker/Dockerfile")).toEqual({
    path: "docker/Dockerfile",
    name: "Dockerfile",
  });

  for (const nonFile of [
    "feat/desktop-chat-welcome",
    "bg-surface/80",
    "min-[901px]:h-[72px]",
    "dark:hidden",
    "chatWelcome.project",
    "window.eta",
    "@eta/core",
    "--flag",
    "https://github.com/Lingwcy/eta/pull/648",
    "apps/desktop/",
  ]) {
    expect(parseInlineCodeFileReference(nonFile), nonFile).toBeNull();
  }
});
