import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Clock3, GitBranch } from "lucide-react";
import { RunningIndicator } from "@/components/ui/running-indicator";

/** Static indicators leave title width flexible and do not poll individual thread runtimes. */
export function ThreadItemStatus({
  running,
  scheduled,
  worktree,
}: {
  running: boolean;
  scheduled: boolean;
  worktree: boolean;
}) {
  useTranslation();
  if (!running && !scheduled && !worktree) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-neutral-500">
      {running && <RunningIndicator />}
      {scheduled && (
        <span
          role="img"
          aria-label={t("navigation:threadItemStatus.hasScheduledTasks")}
          title={t("navigation:threadItemStatus.hasScheduledTasks")}
        >
          <Clock3 size={13} aria-hidden="true" />
        </span>
      )}
      {worktree && (
        <span
          role="img"
          aria-label={t("navigation:threadItemStatus.usesAWorktree")}
          title={t("navigation:threadItemStatus.usesAWorktree")}
        >
          <GitBranch size={13} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
