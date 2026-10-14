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
  if (!running && !scheduled && !worktree) return null;
  return (
    <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-neutral-400">
      {running && <RunningIndicator />}
      {scheduled && (
        <span role="img" aria-label="有定时任务" title="有定时任务">
          <Clock3 size={13} aria-hidden="true" />
        </span>
      )}
      {worktree && (
        <span role="img" aria-label="使用 worktree" title="使用 worktree">
          <GitBranch size={13} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
