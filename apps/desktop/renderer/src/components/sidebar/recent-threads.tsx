import { threadTitle } from "@/i18n/thread-title";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { ThreadVisit } from "@/agent/thread-recents";
import { threadProjectId } from "@eta/core/shared/thread-project";
import { Button } from "@/components/ui/button";
import { ThreadContextMenu } from "../threads/thread-actions";
import { ThreadItemStatus } from "./thread-item-status";
import { scheduleTime } from "../schedules/format";

export function recentDay(time: number, now: number) {
  const date = new Date(time);
  const today = new Date(now);
  const day = (value: Date) => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const distance = (day(today) - day(date)) / 86400_000;
  return distance === 0
    ? t("navigation:recentThreads.today")
    : distance === 1
      ? t("navigation:recentThreads.yesterday")
      : t("navigation:recentThreads.earlier");
}

export function RecentThreads({
  library,
  visits,
  previews,
  archived,
  selected,
  running,
  scheduled,
  worktrees,
  busy,
  onSelect,
}: {
  library: DesktopLibrary | null;
  visits: readonly ThreadVisit[];
  previews?: ReadonlyMap<string, string>;
  archived: boolean;
  selected: string | null;
  running: ReadonlySet<string>;
  scheduled: ReadonlySet<string>;
  worktrees: ReadonlySet<string>;
  busy: boolean;
  onSelect: (id: string) => void;
}) {
  useTranslation();
  const threads = new Map(library?.threads.map((thread) => [thread.id, thread]));
  const projects = new Map(library?.projects.map((project) => [project.id, project.name]));
  const rows = visits.flatMap((visit) => {
    const thread = threads.get(visit.threadId);
    return thread && (thread.archivedAt !== undefined) === archived ? [{ visit, thread }] : [];
  });
  const now = Date.now();
  return (
    <div>
      {[
        t("navigation:recentThreads.today"),
        t("navigation:recentThreads.yesterday"),
        t("navigation:recentThreads.earlier"),
      ].map((day, index) => {
        const group = rows.filter(({ visit }) => recentDay(visit.visitedAt, now) === day);
        if (!group.length) return null;
        return (
          <section key={index}>
            <p className="px-2 pt-2 pb-1 text-xs text-neutral-600">{day}</p>
            <div className="flex flex-col gap-1">
              {group.map(({ visit, thread }) => (
                <ThreadContextMenu key={thread.id} id={thread.id}>
                  <Button
                    variant="ghost"
                    size="row-sm"
                    selected={selected === thread.id}
                    aria-current={selected === thread.id ? "page" : undefined}
                    title={thread.title}
                    disabled={busy}
                    onClick={() => onSelect(thread.id)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span
                          className={`min-w-0 flex-1 truncate ${selected === thread.id ? "font-medium" : ""}`}
                        >
                          {threadTitle(thread)}
                        </span>
                        <span className="max-w-14 truncate text-xs text-neutral-600">
                          {projects.get(threadProjectId(thread, library!) ?? "") ??
                            t("navigation:recentThreads.ungrouped")}
                        </span>
                        <ThreadItemStatus
                          running={running.has(thread.id)}
                          scheduled={scheduled.has(thread.id)}
                          worktree={worktrees.has(thread.id)}
                        />
                      </span>
                      <span className="line-clamp-2 text-xs leading-4 text-neutral-600">
                        {previews?.get(thread.id) || scheduleTime(visit.visitedAt)}
                      </span>
                    </span>
                  </Button>
                </ThreadContextMenu>
              ))}
            </div>
          </section>
        );
      })}
      {!rows.length && (
        <p className="px-2 py-3 text-xs text-neutral-600">
          {t("navigation:recentThreads.sentMessagesWillAppearHere")}
        </p>
      )}
    </div>
  );
}
