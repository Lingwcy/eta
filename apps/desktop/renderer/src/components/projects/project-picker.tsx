import { useEffect, useState } from "react";
import { FolderClosed, Plus, X } from "lucide-react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { CreateProjectDialog } from "./create-project-dialog";

export function ProjectPicker({
  library,
  workspaceId,
  projectName,
  cwd,
  disabled,
  onSelect,
  onCreate,
}: {
  library: DesktopLibrary | null;
  workspaceId: string | null;
  projectName?: string;
  cwd?: string;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onCreate: (rootPath: string, name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (disabled || creating || event.isComposing || event.defaultPrevented) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [disabled, creating]);
  const options = (library?.workspaces ?? [])
    .map((workspace) => ({
      id: workspace.id,
      label: `${library?.projects.find((project) => project.id === workspace.projectId)?.name ?? "项目"}${workspace.kind === "worktree" ? ` · ${workspace.cwd.split(/[\\/]/).at(-1)}` : ""}`,
      cwd: workspace.cwd,
    }))
    .filter((option) =>
      `${option.label} ${option.cwd}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        {workspaceId && (
          <Tooltip content="不在项目中工作">
            <Button
              variant="default"
              size="icon-tiny"
              disabled={disabled}
              aria-label="移除已选项目"
              onClick={() => onSelect(null)}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
        >
          <Tooltip
            content={
              workspaceId ? (
                cwd
              ) : (
                <span className="flex items-center gap-2">
                  选择一个项目来运行聊天<Kbd variant="badge">⌥⇧⌘O</Kbd>
                </span>
              )
            }
          >
            <PopoverTrigger
              disabled={disabled}
              render={<Button variant={workspaceId ? "ghost" : "secondary"} size="pill" />}
            >
              {!workspaceId && <FolderClosed size={17} aria-hidden="true" />}
              <span className="max-w-40 truncate">{projectName ?? "选择项目"}</span>
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent aria-label="选择项目">
            <Command
              items={options}
              mode="none"
              inline
              open
              autoHighlight="always"
              value={query}
              onValueChange={setQuery}
              itemToStringValue={(option) => option.label}
            >
              <div className="mx-3 border-b border-neutral-200">
                <CommandInput variant="search" aria-label="搜索项目" placeholder="搜索项目" />
              </div>
              <CommandList size="compact">
                {options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option}
                    title={option.cwd}
                    onClick={() => {
                      onSelect(option.id);
                      setOpen(false);
                      setQuery("");
                    }}
                  >
                    <FolderClosed size={17} aria-hidden="true" />
                    <span className="truncate">{option.label}</span>
                  </CommandItem>
                ))}
                {!options.length && (
                  <p className="px-3 py-4 text-sm text-neutral-400">
                    {query ? "没有匹配的项目" : "还没有项目"}
                  </p>
                )}
              </CommandList>
            </Command>
            <div className="mx-3 shrink-0 border-t border-neutral-200 py-2">
              <Button
                variant="ghost"
                size="row"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
              >
                <Plus size={18} aria-hidden="true" />
                新建项目
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} onCreate={onCreate} />
    </>
  );
}
