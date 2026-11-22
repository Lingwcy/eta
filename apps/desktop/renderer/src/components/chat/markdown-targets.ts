export interface FileReference {
  readonly path: string;
  readonly name: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly column?: number;
}

export type MarkdownLinkTarget =
  | { readonly kind: "file"; readonly file: FileReference }
  | {
      readonly kind: "github-pr";
      readonly url: string;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
      readonly label: string;
    }
  | {
      readonly kind: "github-issue";
      readonly url: string;
      readonly owner: string;
      readonly repo: string;
      readonly number: number;
      readonly label: string;
    }
  | { readonly kind: "web"; readonly url: string; readonly host: string }
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "unsafe" };

const recognizedExtensions = new Set([
  "ts",
  "mts",
  "cts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "json",
  "jsonc",
  "json5",
  "md",
  "mdx",
  "txt",
  "yml",
  "yaml",
  "toml",
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "hpp",
  "sql",
  "graphql",
  "gql",
  "vue",
  "svelte",
  "astro",
  "diff",
  "patch",
  "ini",
  "conf",
  "env",
  "prisma",
  "lock",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "ico",
  "icns",
]);

const extensionlessNames = new Set([
  "Dockerfile",
  "Makefile",
  "GNUmakefile",
  "LICENSE",
  "README",
  "Procfile",
  "Gemfile",
  "Rakefile",
]);

const rootKnownFilenames = new Set([
  "package.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.build.json",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  "LESSONS.md",
  "Dockerfile",
  "Makefile",
  ".gitignore",
  ".env",
  ".env.example",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
]);

function extractBaseName(filePath: string) {
  const cleaned = filePath.replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).at(-1) || filePath;
}

function parsePositiveInt(raw: string | undefined) {
  if (!raw) return undefined;
  const num = Number(raw);
  return Number.isSafeInteger(num) && num > 0 ? num : undefined;
}

function stripLineSuffix(raw: string): {
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
} {
  const hashMatch = raw.match(/#l(\d+)(?:c(\d+))?(?:-l?(\d+)(?:c\d+)?)?$/i);
  if (hashMatch && hashMatch.index !== undefined && hashMatch.index > 0) {
    const line = parsePositiveInt(hashMatch[1]);
    const column = parsePositiveInt(hashMatch[2]);
    const endRaw = parsePositiveInt(hashMatch[3]);
    const endLine = line && endRaw && endRaw >= line ? endRaw : undefined;
    if (line) {
      return {
        path: raw.slice(0, hashMatch.index),
        line,
        ...(endLine ? { endLine } : {}),
        ...(column ? { column } : {}),
      };
    }
  }

  const colonColMatch = raw.match(/:(\d+):(\d+)$/);
  if (colonColMatch && colonColMatch.index !== undefined && colonColMatch.index > 0) {
    const line = parsePositiveInt(colonColMatch[1]);
    const column = parsePositiveInt(colonColMatch[2]);
    if (line && column) {
      return { path: raw.slice(0, colonColMatch.index), line, column };
    }
  }

  const colonRangeMatch = raw.match(/:(\d+)-(\d+)$/);
  if (colonRangeMatch && colonRangeMatch.index !== undefined && colonRangeMatch.index > 0) {
    const line = parsePositiveInt(colonRangeMatch[1]);
    const endRaw = parsePositiveInt(colonRangeMatch[2]);
    const endLine = line && endRaw && endRaw >= line ? endRaw : undefined;
    if (line) {
      return {
        path: raw.slice(0, colonRangeMatch.index),
        line,
        ...(endLine ? { endLine } : {}),
      };
    }
  }

  const colonLineMatch = raw.match(/:(\d+)$/);
  if (colonLineMatch && colonLineMatch.index !== undefined && colonLineMatch.index > 0) {
    const line = parsePositiveInt(colonLineMatch[1]);
    if (line) return { path: raw.slice(0, colonLineMatch.index), line };
  }

  return { path: raw };
}

function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** Preserves safe local file links alongside standard web/mailto links while dropping dangerous schemes. */
export function markdownUrlTransform(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  ) {
    return url;
  }
  const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return url;
  const scheme = schemeMatch[1]!.toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "file"
    ? url
    : "";
}

/** Parses a `file://` URL or local path (with optional `:line` / `#Lline` locator) into a FileReference. */
export function parseFileReference(raw: string): FileReference | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^file:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") return null;
    let pathname = decodePathname(parsed.pathname);
    if (/^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
    if (!pathname) return null;
    const hashRef = parsed.hash ? stripLineSuffix(`x${parsed.hash}`) : undefined;
    const pathRef = stripLineSuffix(pathname);
    const line = hashRef?.line ?? pathRef.line;
    const endLine = hashRef?.endLine ?? pathRef.endLine;
    const column = hashRef?.column ?? pathRef.column;
    const cleanPath = pathRef.path;
    if (!cleanPath || cleanPath.endsWith("/")) return null;
    return {
      path: cleanPath,
      name: extractBaseName(cleanPath),
      ...(line ? { line } : {}),
      ...(endLine ? { endLine } : {}),
      ...(column ? { column } : {}),
    };
  }

  const stripped = stripLineSuffix(trimmed);
  const cleanPath = stripped.path;
  if (!cleanPath || cleanPath.endsWith("/") || cleanPath.endsWith("\\")) return null;
  return {
    path: cleanPath,
    name: extractBaseName(cleanPath),
    ...(stripped.line ? { line: stripped.line } : {}),
    ...(stripped.endLine ? { endLine: stripped.endLine } : {}),
    ...(stripped.column ? { column: stripped.column } : {}),
  };
}

/** Classifies a Markdown link href into a file, GitHub PR/Issue, web URL, external mailto, or unsafe target. */
export function classifyMarkdownLink(href: string | undefined): MarkdownLinkTarget {
  if (!href || !href.trim()) return { kind: "unsafe" };
  const trimmed = href.trim();

  if (/^file:\/\//i.test(trimmed)) {
    const file = parseFileReference(trimmed);
    return file ? { kind: "file", file } : { kind: "unsafe" };
  }

  if (/^mailto:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return { kind: "external", url: parsed.href };
    } catch {
      return { kind: "unsafe" };
    }
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { kind: "unsafe" };
    }
    const host = parsed.hostname.toLowerCase();
    if (host === "github.com" || host === "www.github.com") {
      const prMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/);
      if (prMatch) {
        const owner = prMatch[1]!;
        const repo = prMatch[2]!;
        const number = Number(prMatch[3]!);
        return {
          kind: "github-pr",
          url: parsed.href,
          owner,
          repo,
          number,
          label: `${repo}#${number}`,
        };
      }
      const issueMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/.*)?$/);
      if (issueMatch) {
        const owner = issueMatch[1]!;
        const repo = issueMatch[2]!;
        const number = Number(issueMatch[3]!);
        return {
          kind: "github-issue",
          url: parsed.href,
          owner,
          repo,
          number,
          label: `${repo}#${number}`,
        };
      }
    }
    return { kind: "web", url: parsed.href, host: parsed.host };
  }

  if (trimmed.startsWith("#")) return { kind: "unsafe" };

  if (/^([a-zA-Z][a-zA-Z0-9+.-]*):/.test(trimmed) && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return { kind: "unsafe" };
  }

  const file = parseFileReference(trimmed);
  return file ? { kind: "file", file } : { kind: "unsafe" };
}

function hasRecognizedFileName(name: string) {
  if (!name) return false;
  if (extensionlessNames.has(name) || name.startsWith("Dockerfile.")) return true;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return recognizedExtensions.has(name.slice(dot + 1).toLowerCase());
}

/** Strictly recognizes workspace file paths in inline code spans without matching classes or branches. */
export function parseInlineCodeFileReference(text: string): FileReference | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed !== text) return null;
  if (trimmed.length < 3 || trimmed.length > 260) return null;
  const restForCharCheck = trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
  if (/[\s[\](){}=<>*?&|;'",`~!]/.test(restForCharCheck)) return null;
  if (
    trimmed.startsWith("-") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("$") ||
    trimmed.startsWith("#") ||
    /^(https?|mailto|file):/i.test(trimmed)
  ) {
    return null;
  }

  const parsed = parseFileReference(trimmed);
  if (!parsed) return null;
  const rawPath = parsed.path;
  if (rawPath.includes("//") || rawPath.includes("...")) return null;

  if (rootKnownFilenames.has(rawPath)) return parsed;

  const isAbsoluteOrHome =
    rawPath.startsWith("/") || rawPath.startsWith("~/") || /^[a-zA-Z]:[\\/]/.test(rawPath);
  if (isAbsoluteOrHome) {
    return hasRecognizedFileName(parsed.name) || rootKnownFilenames.has(parsed.name)
      ? parsed
      : null;
  }

  if (rawPath.includes("/")) {
    return hasRecognizedFileName(parsed.name) || rootKnownFilenames.has(parsed.name)
      ? parsed
      : null;
  }

  return null;
}

/** Formats optional line or range locator for display and clipboard copying. */
export function formatFileLineSuffix(file: Pick<FileReference, "line" | "endLine">) {
  if (!file.line) return "";
  if (file.endLine && file.endLine > file.line) return `:${file.line}-${file.endLine}`;
  return `:${file.line}`;
}
