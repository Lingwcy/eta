import { Archive, FolderPlus, Home, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { useUpdateState } from "@/agent/use-update-state";

interface Props {
  archived: boolean;
  busy: boolean;
  onHome: () => void;
  onArchive?: () => void;
  settingsActive?: boolean;
  onChoose: () => void;
  /** Receives "about" when a downloaded update is waiting, so the badge leads to it. */
  onSettings: (category?: string) => void;
}
export function NavigationRail({
  archived,
  busy,
  onHome,
  onArchive,
  onChoose,
  onSettings,
  settingsActive = false,
}: Props) {
  const [update] = useUpdateState();
  const updateReady = update?.status === "downloaded";
  return (
    <nav
      className="flex w-[var(--rail-width)] shrink-0 flex-col items-center gap-3 py-2"
      aria-label="主导航"
    >
      <Button
        variant="ghost-muted"
        size="icon"
        selected={!archived && !settingsActive}
        title="项目与会话"
        aria-label="项目与会话"
        aria-pressed={!archived && !settingsActive}
        onClick={onHome}
      >
        <Home size={21} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon"
        selected={archived && !settingsActive}
        title="已归档会话"
        aria-label="已归档会话"
        aria-pressed={archived && !settingsActive}
        disabled={!onArchive}
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
      <Avatar label="Eta" fallback="η" src="./favicon.svg" />
      <div className="relative">
        <Button
          variant="ghost-muted"
          size="icon"
          title={updateReady ? "设置 / 有可安装的更新" : "设置 / 模型与认证"}
          aria-label={updateReady ? "设置 / 有可安装的更新" : "设置 / 模型与认证"}
          selected={settingsActive}
          aria-pressed={settingsActive}
          onClick={() => onSettings(updateReady ? "about" : undefined)}
        >
          <Settings size={21} aria-hidden="true" />
        </Button>
        {updateReady && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 right-1.5 size-2 rounded-full bg-[#ed714b]"
          />
        )}
      </div>
    </nav>
  );
}
