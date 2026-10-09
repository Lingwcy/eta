import { projectRootWorkspace } from "@/desktop/selectors";
import { threadProjectId } from "../../../src/shared/thread-project.ts";
import { ThreadContextMenu } from "./threads/thread-actions";
import { Button } from "./ui/button";
import { SlidingLabel } from "./sidebar/sliding-label";
import { useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { NavigationRail } from "./sidebar/navigation-rail";
import { ProjectSidebar } from "./sidebar/project-sidebar";
import { ProjectGroup } from "./sidebar/project-group";
import { ThreadSearchDialog } from "./sidebar/thread-search-dialog";
import { cn } from "@/lib/utils";

interface Props {
  library: DesktopLibrary | null;
  runningThreadIds: ReadonlySet<string>;
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
  const [archived, setArchived] = useState(false);
  const sidebarWorkspace = (thread: DesktopLibrary["threads"][number]) => {
    if (thread.projectId === undefined) return thread.workspaceId;
    return props.library
      ? projectRootWorkspace(props.library.workspaces, thread.projectId)?.id
      : undefined;
  };
  const ungrouped =
    props.library?.threads.filter(
      (thread) =>
        threadProjectId(thread, props.library!) === null &&
        (thread.archivedAt !== undefined) === archived,
    ) ?? [];
  const groups =
    props.library?.workspaces.map((workspace) => {
      const project = props.library?.projects.find((project) => project.id === workspace.projectId);
      const name = `${project?.name ?? "项目"}${workspace.kind === "worktree" ? ` · ${workspace.cwd.split("/").at(-1)}` : ""}`;
      const threads =
        props.library?.threads
          .filter(
            (thread) =>
              sidebarWorkspace(thread) === workspace.id &&
              (thread.archivedAt !== undefined) === archived,
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
        archived={archived}
        busy={props.busy}
        onHome={() => {
          setArchived(false);
          props.onExpand();
        }}
        onArchive={() => {
          setArchived((value) => !value);
          props.onExpand();
        }}
        onChoose={props.onChoose}
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
        <ProjectSidebar
          archived={archived}
          canCreate={!props.busy && !!props.library}
          search={
            <ThreadSearchDialog
              library={props.library}
              archived={archived}
              busy={props.busy}
              canCreate={!props.busy && !!props.library}
              runningThreadIds={props.runningThreadIds}
              onSelect={props.onSelect}
              onNew={props.onNew}
              onChoose={props.onChoose}
              onSkills={props.onSkills}
            />
          }
          onNew={props.onNew}
        >
          {groups.map((group) => (
            <ProjectGroup
              key={group.workspace.id}
              {...group}
              selected={props.workspaceId === group.workspace.id}
              threadId={props.threadId}
              runningThreadIds={props.runningThreadIds}
              busy={props.busy}
              archived={archived}
              onSelect={props.onSelect}
            />
          ))}
          {ungrouped.length > 0 && (
            <>
              <p className="px-2 pt-2 pb-1 text-xs font-medium text-neutral-500">未分组</p>
              {ungrouped.map((thread) => (
                <ThreadContextMenu key={thread.id} id={thread.id}>
                  <Button
                    variant="ghost"
                    size="row-compact"
                    selected={props.threadId === thread.id}
                    disabled={props.busy}
                    onClick={() => props.onSelect(thread.id)}
                  >
                    <SlidingLabel text={thread.title || "新聊天"} />
                  </Button>
                </ThreadContextMenu>
              ))}
            </>
          )}
          {!groups.length && (
            <p className="px-3 py-2 text-xs text-neutral-400">打开项目，开始协作</p>
          )}
        </ProjectSidebar>
      </div>
    </>
  );
}
