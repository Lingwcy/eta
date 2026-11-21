import {
  Atom,
  Braces,
  FileCode2,
  FileJson2,
  FileTerminal,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const jsonExtensions = new Set(["json", "jsonc", "json5"]);
const styleExtensions = new Set(["css", "scss", "sass", "less"]);
const shellExtensions = new Set(["sh", "bash", "zsh", "fish"]);
const imageExtensions = new Set(["svg", "png", "jpg", "jpeg", "webp", "gif", "ico"]);
const codeExtensions = new Set([
  "html",
  "htm",
  "xml",
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
  "yml",
  "yaml",
  "toml",
  "prisma",
]);

/** Renders a file-type glyph matching the extension or filename. */
export function FileTypeIcon({
  name,
  size = 15,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const lower = name.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").at(-1) : undefined;
  if (extension === "tsx" || extension === "jsx") {
    return (
      <Atom
        size={size}
        className={cn("shrink-0 text-sky-text-500 dark:text-sky-text-300", className)}
        aria-hidden="true"
      />
    );
  }
  const badge =
    extension === "ts" || extension === "mts" || extension === "cts"
      ? { text: "TS", color: "text-info-text-500 dark:text-info-text-300" }
      : extension === "js" || extension === "mjs" || extension === "cjs"
        ? { text: "JS", color: "text-warning-text-600 dark:text-warning-text-300" }
        : undefined;
  if (badge) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 18 18"
        className={cn("shrink-0", badge.color, className)}
        aria-hidden="true"
      >
        <rect width="18" height="18" rx="4" fill="currentColor" fillOpacity="0.16" />
        <text x="9" y="12.5" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="600">
          {badge.text}
        </text>
      </svg>
    );
  }
  if (extension && styleExtensions.has(extension)) {
    return (
      <Braces
        size={size}
        className={cn("shrink-0 text-violet-text-500 dark:text-violet-text-400", className)}
        aria-hidden="true"
      />
    );
  }
  if (extension && jsonExtensions.has(extension)) {
    return (
      <FileJson2
        size={size}
        className={cn("shrink-0 text-warning-text-600 dark:text-warning-text-300", className)}
        aria-hidden="true"
      />
    );
  }
  if (extension && imageExtensions.has(extension)) {
    return (
      <ImageIcon
        size={size}
        className={cn("shrink-0 text-danger-text-500 dark:text-danger-text-400", className)}
        aria-hidden="true"
      />
    );
  }
  if (extension && shellExtensions.has(extension)) {
    return (
      <FileTerminal
        size={size}
        className={cn("shrink-0 text-success-text-600 dark:text-success-text-400", className)}
        aria-hidden="true"
      />
    );
  }
  if (
    (extension && codeExtensions.has(extension)) ||
    lower === "dockerfile" ||
    lower === "makefile"
  ) {
    return (
      <FileCode2
        size={size}
        className={cn("shrink-0 text-subtle dark:text-muted", className)}
        aria-hidden="true"
      />
    );
  }
  return (
    <FileText size={size} className={cn("shrink-0 text-muted", className)} aria-hidden="true" />
  );
}
