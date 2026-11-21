export interface FileEditorOption {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceFilePreviewInput {
  readonly workspaceId?: string;
  readonly path: string;
}

export type WorkspaceFileUnavailableReason =
  | "missing"
  | "directory"
  | "binary"
  | "too-large"
  | "cloud-unsupported"
  | "unreadable";

export type WorkspaceFilePreviewResult =
  | {
      readonly status: "ready";
      readonly absolutePath: string;
      readonly displayPath: string;
      readonly rootName?: string;
      readonly name: string;
      readonly language?: string;
      readonly content: string;
      readonly truncated: boolean;
      readonly totalLines: number;
      readonly size: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: WorkspaceFileUnavailableReason;
      readonly absolutePath?: string;
      readonly displayPath: string;
    };

export type OpenFileTargetMode =
  | { readonly kind: "reveal" }
  | { readonly kind: "default" }
  | { readonly kind: "choose" }
  | { readonly kind: "editor"; readonly editorId: string };

export interface OpenFileTargetInput {
  readonly workspaceId?: string;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly mode: OpenFileTargetMode;
}

const extensionLanguages: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  conf: "ini",
  env: "ini",
  prisma: "prisma",
};

const specialFileLanguages: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
};

/** Maps a filename or extension to a Shiki-compatible language identifier. */
export function languageForFileName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (Object.hasOwn(specialFileLanguages, lower)) return specialFileLanguages[lower];
  if (lower.startsWith("dockerfile.")) return "dockerfile";
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return undefined;
  const ext = lower.slice(dot + 1);
  return Object.hasOwn(extensionLanguages, ext) ? extensionLanguages[ext] : undefined;
}
