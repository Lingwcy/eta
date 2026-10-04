import { useState } from "react";
import { FolderClosed, FolderOpen } from "lucide-react";
import { RunningIndicator } from "@/components/ui/running-indicator";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import { SlidingLabel } from "./sliding-label";

interface Props {
  name: string;
  workspace: DesktopLibrary["workspaces"][number];
  threads: DesktopLibrary["threads"];
  selected: boolean;
  threadId: string | null;
  running: boolean;
  runningThreadIds: ReadonlySet<string>;
  busy: boolean;
  archived: boolean;
  onSelect: (id: string) => void;
}
export function ProjectGroup({
  name,
  workspace,
  threads,
  selected,
  threadId,
  running,
  runningThreadIds,
  busy,
  archived,
  onSelect,
}: Props) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded;
  const projectSelected = selected && !threadId;
  const visibleThreads = showAll ? threads : threads.slice(0, 5);
  const showProjectActivity =
    running && (!open || !visibleThreads.some((thread) => runningThreadIds.has(thread.id)));
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2 flex flex-col gap-0.5">
      <CollapsibleTrigger
        variant="ghost"
        size="row-compact"
        selected={projectSelected}
        aria-current={projectSelected ? "page" : undefined}
        title={workspace.cwd}
      >
        {open ? (
          <FolderOpen size={18} aria-hidden="true" />
        ) : (
          <FolderClosed size={18} aria-hidden="true" />
        )}
        <SlidingLabel text={name} />
        {showProjectActivity && (
          <span className="ml-auto">
            <RunningIndicator />
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-0.5">
        {visibleThreads.map((thread) => (
          <Button
            key={thread.id}
            variant="ghost"
            size="row-compact"
            indent
            selected={threadId === thread.id}
            aria-current={threadId === thread.id ? "page" : undefined}
            title={thread.title}
            disabled={busy}
            onClick={() => onSelect(thread.id)}
          >
            <SlidingLabel text={thread.title || "新聊天"} />
            {runningThreadIds.has(thread.id) && (
              <span className="ml-auto">
                <RunningIndicator />
              </span>
            )}
          </Button>
        ))}
        {threads.length > 5 && (
          <Button
            variant="ghost-muted"
            size="row-compact"
            indent
            aria-expanded={showAll}
            onClick={() => setExpanded((value) => !value)}
          >
            {showAll ? "收起显示" : "展开显示"}
          </Button>
        )}
        {selected && !threads.length && (
          <p className="py-2 pr-2 pl-8 text-xs/6 text-neutral-400">
            {archived ? "没有归档会话" : "开始你的第一个聊天"}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
