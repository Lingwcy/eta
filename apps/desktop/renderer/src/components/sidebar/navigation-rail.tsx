import { Archive, FolderPlus, Home, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";

interface Props {
  archived: boolean;
  busy: boolean;
  onHome: () => void;
  onArchive: () => void;
  onChoose: () => void;
  onSettings: () => void;
}
export function NavigationRail({ archived, busy, onHome, onArchive, onChoose, onSettings }: Props) {
  return (
    <nav className="flex w-[50px] shrink-0 flex-col items-center gap-3 py-2" aria-label="主导航">
      <Button
        variant="ghost-muted"
        size="icon"
        selected={!archived}
        title="项目与会话"
        aria-label="项目与会话"
        aria-pressed={!archived}
        onClick={onHome}
      >
        <Home size={21} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon"
        selected={archived}
        title="已归档会话"
        aria-label="已归档会话"
        aria-pressed={archived}
        onClick={onArchive}
      >
        <Archive size={20} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon"
        title="打开项目目录"
        aria-label="打开项目目录"
        disabled={busy}
        onClick={onChoose}
      >
        <FolderPlus size={21} aria-hidden="true" />
      </Button>
      <div className="flex-1" />
      <Button
        variant="ghost-muted"
        size="icon"
        title="设置 / 模型与认证"
        aria-label="设置 / 模型与认证"
        onClick={onSettings}
      >
        <Settings2 size={21} aria-hidden="true" />
      </Button>
      <Avatar label="Eta" fallback="e" />
    </nav>
  );
}
