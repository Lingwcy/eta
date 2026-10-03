import { PanelLeft, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function WindowToolbar({
  collapsed,
  canCreate,
  onToggle,
  onNew,
}: {
  collapsed: boolean;
  canCreate: boolean;
  onToggle: () => void;
  onNew: () => void;
}) {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 px-3 [-webkit-app-region:drag] min-[1600px]:h-[52px]",
        navigator.userAgent.includes("Mac") && "pl-[105px]",
      )}
    >
      <div className="[-webkit-app-region:no-drag]">
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={collapsed ? "显示侧栏" : "隐藏侧栏"}
          title="切换侧栏 (⌘ B)"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <PanelLeft size={18} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1" />
      <div className="[-webkit-app-region:no-drag]">
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="新聊天"
          title="新聊天 (⌘ N)"
          disabled={!canCreate}
          onClick={onNew}
        >
          <SquarePen size={18} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
