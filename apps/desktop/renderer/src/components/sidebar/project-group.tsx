import { useState } from "react";
import { FolderClosed } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DesktopLibrary } from "../../../../src/bridge.ts";

interface Props {
  name: string;
  workspace: DesktopLibrary["workspaces"][number];
  threads: DesktopLibrary["threads"];
  selected: boolean;
  threadId: string | null;
  busy: boolean;
  searching: boolean;
  archived: boolean;
  onWorkspace: (id: string) => void;
  onSelect: (id: string) => void;
}
export function ProjectGroup({
  name,
  workspace,
  threads,
  selected,
  threadId,
  busy,
  searching,
  archived,
  onWorkspace,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || searching;
  return (
    <section className="mb-4">
      <Button
        variant="ghost"
        size="row"
        selected={selected}
        aria-current={selected ? "true" : undefined}
        disabled={busy}
        title={workspace.cwd}
        onClick={() => onWorkspace(workspace.id)}
      >
        <FolderClosed size={18} aria-hidden="true" />
        <span className="truncate">{name}</span>
      </Button>
      {(showAll ? threads : threads.slice(0, 5)).map((thread) => (
        <Button
          key={thread.id}
          variant="ghost"
          size="row-sm"
          indent
          selected={threadId === thread.id}
          aria-current={threadId === thread.id ? "page" : undefined}
          title={thread.title}
          onClick={() => onSelect(thread.id)}
        >
          <span className="truncate">{thread.title || "新聊天"}</span>
        </Button>
      ))}
      {threads.length > 5 && !searching && (
        <Button
          variant="ghost-muted"
          size="row-sm"
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
    </section>
  );
}
