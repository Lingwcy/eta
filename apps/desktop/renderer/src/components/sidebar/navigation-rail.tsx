import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Clock, Home, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NavigationQuota } from "./navigation-quota";
import type { ConversationTab } from "@/agent/desktop-tabs";
import type { DesktopLibraryController } from "@/agent/use-desktop-library";
import { useUpdateState } from "@/agent/use-update-state";

interface Props {
  conversation?: ConversationTab;
  model?: DesktopLibraryController["mainModel"];
  library?: DesktopLibraryController["library"];
  schedulesActive?: boolean;
  onSchedules?: () => void;
  onHome: () => void;
  settingsActive?: boolean;
  /** Receives "about" when a downloaded update is waiting, so the badge leads to it. */
  onSettings: (category?: string) => void;
}
export function NavigationRail({
  conversation,
  model,
  library,
  schedulesActive = false,
  onSchedules,
  onHome,
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
        selected={!settingsActive && !schedulesActive}
        title={t("navigation:navigationRail.projectsAndChats")}
        aria-label={t("navigation:navigationRail.projectsAndChats")}
        aria-pressed={!settingsActive && !schedulesActive}
        onClick={onHome}
      >
        <Home size={21} aria-hidden="true" />
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
      <div className="flex-1" />
      <NavigationQuota model={model} library={library} conversation={conversation} />
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
