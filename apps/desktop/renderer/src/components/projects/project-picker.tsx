import { useEffect, useState } from "react";
import { Check, FolderClosed, Plus } from "lucide-react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
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
        <Popover
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setQuery("");
          }}
        >
          <PopoverTrigger
            disabled={disabled}
            openOnHover
            delay={120}
            closeDelay={180}
            aria-label="选择项目"
            aria-keyshortcuts="Control+Alt+Shift+O Meta+Alt+Shift+O"
            aria-description={cwd}
            render={<Button variant="ghost" size="pill" selected={open} />}
          >
            <FolderClosed size={17} aria-hidden="true" />
            <span className="max-w-40 truncate">{projectName ?? "选择项目"}</span>
          </PopoverTrigger>
          <PopoverContent variant="menu" aria-label="选择项目">
            <Command
              items={options}
              mode="none"
              inline
              open
              autoHighlight={false}
              value={query}
              onValueChange={setQuery}
              itemToStringValue={(option) => option.label}
            >
              <CommandInput variant="menu-search" aria-label="搜索项目" placeholder="搜索项目" />
              <div className="mx-1.5 my-1 h-px shrink-0 bg-black/10" />
              <CommandList size="menu">
                {options.map((option) => (
                  <CommandItem
                    variant="menu"
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
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.id === workspaceId && <Check size={17} aria-hidden="true" />}
                  </CommandItem>
                ))}
                {!options.length && (
                  <p className="px-2 py-3 text-xs text-neutral-400">
                    {query ? "没有匹配的项目" : "还没有项目"}
                  </p>
                )}
              </CommandList>
            </Command>
            <div className="mx-1.5 my-1 h-px shrink-0 bg-black/10" />
            <div className="shrink-0">
              <Button
                variant="menu"
                size="menu-item"
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
