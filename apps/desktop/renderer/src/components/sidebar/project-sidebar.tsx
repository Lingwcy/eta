import { type ReactNode } from "react";
import { SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Kbd } from "@/components/ui/kbd";

interface Props {
  children: ReactNode;
  archived: boolean;
  canCreate: boolean;
  search: ReactNode;
  onNew: () => void;
}
export function ProjectSidebar({ children, archived, canCreate, search, onNew }: Props) {
  return (
    <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#f8f8f8] px-2 pt-2 pb-2">
      <div className="flex items-center gap-1 pb-2">
        <div className="min-w-0 flex-1">
          <Button variant="ghost" size="row-compact" onClick={onNew} disabled={!canCreate}>
            <SquarePen size={19} aria-hidden="true" />
            新聊天
            <span className="ml-auto hidden min-[901px]:block">
              <Kbd>⌘ N</Kbd>
            </span>
          </Button>
        </div>
        {search}
      </div>
      <div className="px-2 pt-2 pb-1.5 text-xs font-medium text-neutral-500">
        {archived ? "已归档" : "项目"}
      </div>
      <ScrollArea className="-mr-2 flex-1">
        <nav aria-label={archived ? "归档会话" : "项目与会话"}>{children}</nav>
      </ScrollArea>
    </aside>
  );
}
