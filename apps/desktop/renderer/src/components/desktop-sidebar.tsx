import { threadTitle } from "@/i18n/thread-title";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import type { ThreadVisit } from "@/agent/thread-recents";
import { RecentThreads } from "./sidebar/recent-threads";
import type { SchedulesController } from "@/agent/use-schedules";
import { ScheduleSidebar } from "./schedules/schedule-sidebar";
import { isCloudId } from "../../../src/shared/bot.ts";
import { projectRootWorkspace } from "@/desktop/selectors";
import { threadProjectId } from "@eta/core/shared/thread-project";
import { ThreadContextMenu } from "./threads/thread-actions";
import { Button } from "./ui/button";
import { SlidingLabel } from "./sidebar/sliding-label";
import { ThreadItemStatus } from "./sidebar/thread-item-status";
import { useMemo, useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { NavigationRail } from "./sidebar/navigation-rail";
import { ProjectSidebar } from "./sidebar/project-sidebar";
import { ProjectGroup } from "./sidebar/project-group";
import { ThreadSearchDialog } from "./sidebar/thread-search-dialog";
import { cn } from "@/lib/utils";

interface Props {
  model?: Parameters<typeof NavigationRail>[0]["model"];
  conversation?: Parameters<typeof NavigationRail>[0]["conversation"];
  scheduleView: boolean;
  onScheduleView(this: void, value: boolean): void;
  schedules: SchedulesController;
  onScheduleSaved(this: void, id: string): void;
  library: DesktopLibrary | null;
  runningThreadIds: ReadonlySet<string>;
  visits?: readonly ThreadVisit[];
  previews?: ReadonlyMap<string, string>;
  workspaceId: string | null;
  threadId: string | null;
  busy: boolean;
  collapsed: boolean;
  onExpand: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChoose: () => void;
  onSettings: (category?: string) => void;
  onSkills: () => void;
}

export function DesktopSidebar(props: Props) {
  useTranslation();
  const scheduleView = props.scheduleView;
  const setScheduleView = props.onScheduleView;
  const [recent, setRecent] = useState(false);
  const scheduledThreadIds = useMemo(
    () =>
      new Set(
        props.schedules.snapshot.snapshots.flatMap(({ data }) =>
          data.schedules
            .filter((plan) => plan.deletedAt === undefined)
            .map((plan) => plan.threadId),
        ),
      ),
    [props.schedules.snapshot],
  );
  const worktreeThreadIds = useMemo(() => {
    const worktrees = new Set(
      props.library?.workspaces
        .filter((workspace) => workspace.kind === "worktree")
        .map((workspace) => workspace.id),
    );
    return new Set(
      props.library?.threads
        .filter((thread) => worktrees.has(thread.workspaceId))
        .map((thread) => thread.id),
    );
  }, [props.library]);
  const sidebarWorkspace = (thread: DesktopLibrary["threads"][number]) => {
    if (thread.projectId === undefined) return thread.workspaceId;
    return props.library
      ? projectRootWorkspace(props.library.workspaces, thread.projectId)?.id
      : undefined;
  };
  const ungrouped =
    props.library?.threads.filter(
      (thread) =>
        threadProjectId(thread, props.library!) === null && thread.archivedAt === undefined,
    ) ?? [];
  const groups =
    props.library?.workspaces
      .filter((workspace) => workspace.kind !== "temporary")
      .map((workspace) => {
        const project = props.library?.projects.find(
          (project) => project.id === workspace.projectId,
        );
        const name = `${project?.name ?? t("navigation:desktopSidebar.projects")}${workspace.kind === "worktree" ? ` · ${workspace.cwd.split("/").at(-1)}` : ""}`;
        const threads =
          props.library?.threads
            .filter(
              (thread) =>
                sidebarWorkspace(thread) === workspace.id && thread.archivedAt === undefined,
            )
            .toSorted(
              (a, b) => b.sessionRef.metadata.modifiedAt - a.sessionRef.metadata.modifiedAt,
            ) ?? [];
        const running =
          props.library?.threads.some(
            (thread) =>
              sidebarWorkspace(thread) === workspace.id && props.runningThreadIds.has(thread.id),
          ) ?? false;
        return { workspace, name, threads, running };
      }) ?? [];
  return (
    <>
      <NavigationRail
        library={props.library}
        model={props.model}
        conversation={props.conversation}
        schedulesActive={scheduleView}
        onSchedules={() => {
          setScheduleView(true);
          props.onExpand();
        }}
        onHome={() => {
          setScheduleView(false);
          setRecent(false);
          props.onExpand();
        }}
        onSettings={props.onSettings}
      />
      <div
        inert={props.collapsed}
        aria-hidden={props.collapsed}
        className={cn(
          "flex shrink-0 overflow-hidden transition-[width] duration-180 ease-out motion-reduce:transition-none",
          props.collapsed ? "w-0" : "w-[var(--sidebar-width)]",
        )}
      >
        {scheduleView ? (
          <ScheduleSidebar
            selectedThreadId={props.threadId}
            library={props.library}
            controller={props.schedules}
            onSelect={props.onSelect}
            onSaved={props.onScheduleSaved}
          />
        ) : (
          <ProjectSidebar
            recent={recent}
            onRecent={() => setRecent((value) => !value)}
            archived={false}
            canCreate={!!props.library}
            search={
              <ThreadSearchDialog
                library={props.library}
                archived={false}
                busy={props.busy}
                canCreate={!!props.library}
                runningThreadIds={props.runningThreadIds}
                scheduledThreadIds={scheduledThreadIds}
                onSelect={props.onSelect}
                onNew={props.onNew}
                onChoose={props.onChoose}
                onSkills={props.onSkills}
                onSchedules={() => {
                  setScheduleView(true);
                  props.onExpand();
                }}
              />
            }
            onNew={props.onNew}
          >
            {recent ? (
              <RecentThreads
                library={props.library}
                visits={props.visits ?? []}
                previews={props.previews}
                archived={false}
                selected={props.threadId}
                running={props.runningThreadIds}
                scheduled={scheduledThreadIds}
                worktrees={worktreeThreadIds}
                onSelect={props.onSelect}
              />
            ) : (
              <>
                {[false, true].map((cloud) => (
                  <div key={String(cloud)}>
                    {groups.some((group) => isCloudId(group.workspace.id) === cloud) && (
                      <p className="px-2 pt-2 pb-1 text-xs font-medium text-subtle">
                        {cloud
                          ? t("navigation:desktopSidebar.cloudProjects", {
                              value1:
                                props.library?.bot?.status === "error"
                                  ? t("navigation:desktopSidebar.offline")
                                  : "",
                            })
                          : t("navigation:desktopSidebar.localProjects")}
                      </p>
                    )}
                    {groups
                      .filter((group) => isCloudId(group.workspace.id) === cloud)
                      .map((group) => (
                        <ProjectGroup
                          key={group.workspace.id}
                          {...group}
                          selected={props.workspaceId === group.workspace.id}
                          threadId={props.threadId}
                          runningThreadIds={props.runningThreadIds}
                          scheduledThreadIds={scheduledThreadIds}
                          worktreeThreadIds={worktreeThreadIds}
                          archived={false}
                          onSelect={props.onSelect}
                        />
                      ))}
                  </div>
                ))}
                {ungrouped.length > 0 && (
                  <>
                    <p className="px-2 pt-2 pb-1 text-xs font-medium text-subtle">
                      {t("navigation:desktopSidebar.ungrouped")}
                    </p>
                    {ungrouped.map((thread) => (
                      <ThreadContextMenu key={thread.id} id={thread.id}>
                        <Button
                          variant="ghost"
                          size="row-compact"
                          selected={props.threadId === thread.id}
                          onClick={() => props.onSelect(thread.id)}
                        >
                          <SlidingLabel text={threadTitle(thread)} />
                          <ThreadItemStatus
                            running={props.runningThreadIds.has(thread.id)}
                            scheduled={scheduledThreadIds.has(thread.id)}
                            worktree={worktreeThreadIds.has(thread.id)}
                          />
                        </Button>
                      </ThreadContextMenu>
                    ))}
                  </>
                )}
                {!groups.length && (
                  <p className="px-3 py-2 text-xs text-muted">
                    {t("navigation:desktopSidebar.openAProjectToStartWorkingTogether")}
                  </p>
                )}
              </>
            )}
          </ProjectSidebar>
        )}
      </div>
    </>
  );
}
