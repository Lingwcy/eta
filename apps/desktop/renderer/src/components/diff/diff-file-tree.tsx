import { useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DiffFile } from "@eta/core/shared/diff";
import { FileTypeIcon } from "@/components/files/file-type-icon";
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

const statuses = {
  added: ["A", "text-success-text-600 dark:text-success-text-400"],
  untracked: ["A", "text-success-text-600 dark:text-success-text-400"],
  modified: ["M", "text-sky-text-600 dark:text-sky-text-400"],
  deleted: ["D", "text-danger-text-600 dark:text-danger-text-400"],
  renamed: ["R", "text-cyan-600 dark:text-cyan-400"],
  conflicted: ["U", "text-warning-text-600 dark:text-warning-text-400"],
  "type-changed": ["T", "text-sky-text-600 dark:text-sky-text-400"],
  submodule: ["S", "text-violet-text-600 dark:text-violet-text-400"],
} as const;
const rowClass =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none hover:bg-surface-hover/50 focus-visible:ring-2 focus-visible:ring-sky-text-500/60 dark:hover:bg-surface/5";

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
              className={cn(rowClass, "text-subtle dark:text-muted")}
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
                className="mr-0.5 size-1.5 shrink-0 rounded-full bg-sky-fill-500/70"
                aria-hidden="true"
              />
            </button>
            {open && (
              <ul className="ml-[13px] border-l border-border/80 pl-2">
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
              selected && "bg-sky-tint-100/80 dark:bg-sky-fill-400/10",
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
