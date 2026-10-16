import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Clock, Archive, FolderPlus, Home, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { useUpdateState } from "@/agent/use-update-state";

interface Props {
  schedulesActive?: boolean;
  onSchedules?: () => void;
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
  schedulesActive = false,
  onSchedules,
  busy,
  onHome,
  onArchive,
  onChoose,
  onSettings,
  settingsActive = false,
}: Props) {
  useTranslation();
  const [update] = useUpdateState();
  const updateReady = update?.status === "downloaded";
  return (
    <nav
      className="flex w-[var(--rail-width)] shrink-0 flex-col items-center gap-3 py-2"
      aria-label={t("navigation:navigationRail.mainNavigation")}
    >
      <Button
        variant="ghost-muted"
        size="icon"
        selected={!archived && !settingsActive && !schedulesActive}
        title={t("navigation:navigationRail.projectsAndChats")}
        aria-label={t("navigation:navigationRail.projectsAndChats")}
        aria-pressed={!archived && !settingsActive && !schedulesActive}
        onClick={onHome}
      >
        <Home size={21} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon"
        selected={archived && !settingsActive && !schedulesActive}
        title={t("navigation:navigationRail.archivedChats")}
        aria-label={t("navigation:navigationRail.archivedChats")}
        aria-pressed={archived && !settingsActive && !schedulesActive}
        disabled={!onArchive}
        onClick={onArchive}
      >
        <Archive size={20} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon"
        title={t("navigation:navigationRail.scheduledTasks")}
        aria-label={t("navigation:navigationRail.scheduledTasks")}
        selected={schedulesActive}
        aria-pressed={schedulesActive}
        disabled={!onSchedules}
        onClick={onSchedules}
      >
        <Clock size={20} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost-muted"
        size="icon"
        title={t("navigation:navigationRail.openProjectFolder")}
        aria-label={t("navigation:navigationRail.openProjectFolder")}
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
          title={
            updateReady
              ? t("navigation:navigationRail.settingsUpdateReadyToInstall")
              : t("navigation:navigationRail.settingsModelsAndAuthentication")
          }
          aria-label={
            updateReady
              ? t("navigation:navigationRail.settingsUpdateReadyToInstall")
              : t("navigation:navigationRail.settingsModelsAndAuthentication")
          }
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
