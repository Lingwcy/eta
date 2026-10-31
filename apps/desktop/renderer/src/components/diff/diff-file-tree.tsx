import { useMemo } from "react";
import { Atom, ChevronDown, ChevronRight, FileText } from "lucide-react";
import type { DiffFile } from "@eta/core/shared/diff";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

type FileNode = { kind: "file"; name: string; file: DiffFile };
type DirectoryNode = { kind: "directory"; name: string; path: string; children: TreeNode[] };
type TreeNode = FileNode | DirectoryNode;
interface Directory {
  name: string;
  path: string;
  directories: Map<string, Directory>;
  files: FileNode[];
}

/** Compact only directory-only chains; deleted files can share a name with a new directory. */
export function buildDiffTree(files: readonly DiffFile[]): TreeNode[] {
  const root: Directory = { name: "", path: "", directories: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let parent = root;
    for (const name of parts.slice(0, -1)) {
      let directory = parent.directories.get(name);
      if (!directory) {
        directory = {
          name,
          path: parent.path ? parent.path + "/" + name : name,
          directories: new Map(),
          files: [],
        };
        parent.directories.set(name, directory);
      }
      parent = directory;
    }
    parent.files.push({ kind: "file", name: parts.at(-1)!, file });
  }
  function children(directory: Directory): TreeNode[] {
    const directories = [...directory.directories.values()].map((entry): DirectoryNode => {
      let current = entry;
      let name = entry.name;
      while (current.files.length === 0 && current.directories.size === 1) {
        current = current.directories.values().next().value!;
        name += "/" + current.name;
      }
      return { kind: "directory", name, path: current.path, children: children(current) };
    });
    return [
      ...directories.sort((a, b) => a.name.localeCompare(b.name)),
      ...directory.files.sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }
  return children(root);
}

function FileTypeIcon({ name }: { name: string }) {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "tsx" || extension === "jsx")
    return (
      <Atom size={15} className="shrink-0 text-sky-500 dark:text-sky-300" aria-hidden="true" />
    );
  const badge =
    extension === "ts" || extension === "mts" || extension === "cts"
      ? { text: "TS", color: "text-blue-500 dark:text-blue-300" }
      : extension === "js" || extension === "mjs" || extension === "cjs"
        ? { text: "JS", color: "text-amber-600 dark:text-amber-300" }
        : extension === "css" || extension === "scss"
          ? { text: "CSS", color: "text-violet-500 dark:text-violet-400" }
          : undefined;
  if (!badge)
    return <FileText size={15} className="shrink-0 text-neutral-400" aria-hidden="true" />;
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 18 18"
      className={cn("shrink-0", badge.color)}
      aria-hidden="true"
    >
      <rect width="18" height="18" rx="4" fill="currentColor" fillOpacity="0.16" />
      <text
        x="9"
        y="12.5"
        textAnchor="middle"
        fill="currentColor"
        fontSize={badge.text.length === 3 ? "8" : "10"}
        fontWeight="600"
      >
        {badge.text}
      </text>
    </svg>
  );
}

const statuses = {
  added: ["A", "text-emerald-600 dark:text-emerald-400"],
  untracked: ["A", "text-emerald-600 dark:text-emerald-400"],
  modified: ["M", "text-sky-600 dark:text-sky-400"],
  deleted: ["D", "text-red-600 dark:text-red-400"],
  renamed: ["R", "text-cyan-600 dark:text-cyan-400"],
  conflicted: ["U", "text-amber-600 dark:text-amber-400"],
  "type-changed": ["T", "text-sky-600 dark:text-sky-400"],
  submodule: ["S", "text-violet-600 dark:text-violet-400"],
} as const;
const rowClass =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none hover:bg-neutral-200/50 focus-visible:ring-2 focus-visible:ring-sky-500/60 dark:hover:bg-white/5";

export function DiffFileTree({
  files,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
}: {
  files: readonly DiffFile[];
  selectedId?: string;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (file: DiffFile) => void;
}) {
  const nodes = useMemo(() => buildDiffTree(files), [files]);
  function renderNodes(entries: readonly TreeNode[]) {
    return entries.map((node) => {
      if (node.kind === "directory") {
        const open = !collapsed.has(node.path);
        const Chevron = open ? ChevronDown : ChevronRight;
        return (
          <li key={"directory:" + node.path}>
            <button
              type="button"
              className={cn(rowClass, "text-neutral-500 dark:text-neutral-400")}
              aria-label={node.path}
              aria-expanded={open}
              title={node.path}
              onClick={() => onToggle(node.path)}
              onKeyDown={(event) => {
                if ((event.key === "ArrowLeft" && open) || (event.key === "ArrowRight" && !open)) {
                  event.preventDefault();
                  onToggle(node.path);
                }
              }}
            >
              <Chevron size={14} className="shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              <span
                className="mr-0.5 size-1.5 shrink-0 rounded-full bg-sky-500/70"
                aria-hidden="true"
              />
            </button>
            {open && (
              <ul className="ml-[13px] border-l border-neutral-200/80 pl-2 dark:border-neutral-800">
                {renderNodes(node.children)}
              </ul>
            )}
          </li>
        );
      }
      const { file } = node;
      const selected = file.id === selectedId;
      const [status, color] = statuses[file.kind];
      return (
        <li key={"file:" + file.id}>
          <button
            type="button"
            aria-label={file.path + ", " + t(`diff:kind.${file.kind}`)}
            aria-pressed={selected}
            title={file.oldPath ? file.oldPath + " → " + file.path : file.path}
            onClick={() => onSelect(file)}
            className={cn(
              rowClass,
              "text-cyan-700 dark:text-cyan-300",
              selected && "bg-sky-100/80 dark:bg-sky-400/10",
            )}
          >
            <FileTypeIcon name={node.name} />
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            <span className={cn("shrink-0 tabular-nums", color)} aria-hidden="true">
              {status}
            </span>
          </button>
        </li>
      );
    });
  }
  return <ul>{renderNodes(nodes)}</ul>;
}
