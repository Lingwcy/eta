import { useRef, useState, type ReactNode } from "react";
import { FolderPlus, Search, SquarePen, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";

interface Props {
  children: ReactNode;
  archived: boolean;
  busy: boolean;
  canCreate: boolean;
  query: string;
  onQuery: (value: string) => void;
  onNew: () => void;
  onChoose: () => void;
}
export function ProjectSidebar({
  children,
  archived,
  busy,
  canCreate,
  query,
  onQuery,
  onNew,
  onChoose,
}: Props) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLElement>(null);
  return (
    <aside className="flex w-[180px] shrink-0 flex-col rounded-l-[14px] border-r border-neutral-100 bg-[#f8f8f8] px-2 pt-3 pb-2 min-[701px]:w-[210px] min-[901px]:w-[236px] min-[1600px]:w-[270px]">
      <div className="flex items-center justify-between px-2 pb-3">
        <h1 className="text-[19px] font-semibold tracking-tight">Eta</h1>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={searchOpen ? "关闭搜索" : "搜索项目与会话"}
          title="搜索项目与会话"
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen((open) => !open);
            onQuery("");
            requestAnimationFrame(() => searchInput.current?.focus());
          }}
        >
          {searchOpen ? <X size={18} /> : <Search size={18} />}
        </Button>
      </div>
      {searchOpen && (
        <div className="mx-1.5 mb-2">
          <Input
            ref={searchInput}
            aria-label="搜索项目与会话"
            placeholder="搜索项目与会话"
            value={query}
            onValueChange={onQuery}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchOpen(false);
                onQuery("");
              }
            }}
          />
        </div>
      )}
      <Button variant="ghost" size="row" onClick={onNew} disabled={!canCreate}>
        <SquarePen size={19} aria-hidden="true" />
        新聊天
        <span className="ml-auto hidden min-[901px]:block">
          <Kbd>⌘ N</Kbd>
        </span>
      </Button>
      <div className="px-2 pt-4 pb-2 text-[13px] font-medium text-neutral-500">
        {archived ? "已归档" : "项目"}
      </div>
      <nav
        aria-label={archived ? "归档会话" : "项目与会话"}
        className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]"
      >
        {children}
      </nav>
      <div className="mt-2">
        <Button variant="ghost-muted" size="row-sm" disabled={busy} onClick={onChoose}>
          <FolderPlus size={17} aria-hidden="true" />
          打开项目
        </Button>
      </div>
    </aside>
  );
}
