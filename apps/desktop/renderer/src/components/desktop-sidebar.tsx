import { useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import { NavigationRail } from "./sidebar/navigation-rail";
import { ProjectSidebar } from "./sidebar/project-sidebar";
import { ProjectGroup } from "./sidebar/project-group";

interface Props {
  library: DesktopLibrary | null;
  workspaceId: string | null;
  threadId: string | null;
  busy: boolean;
  collapsed: boolean;
  onExpand: () => void;
  onWorkspace: (id: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChoose: () => void;
  onSettings: () => void;
}

export function DesktopSidebar(props: Props) {
  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const search = query.trim().toLocaleLowerCase();
  const groups =
    props.library?.workspaces
      .map((workspace) => {
        const project = props.library?.projects.find(
          (project) => project.id === workspace.projectId,
        );
        const name = `${project?.name ?? "项目"}${workspace.kind === "worktree" ? ` · ${workspace.cwd.split("/").at(-1)}` : ""}`;
        const threads =
          props.library?.threads
            .filter(
              (thread) =>
                thread.workspaceId === workspace.id &&
                (thread.archivedAt !== undefined) === archived &&
                (!search ||
                  name.toLocaleLowerCase().includes(search) ||
                  thread.title.toLocaleLowerCase().includes(search)),
            )
            .toSorted(
              (a, b) => b.sessionRef.metadata.modifiedAt - a.sessionRef.metadata.modifiedAt,
            ) ?? [];
        return { workspace, name, threads };
      })
      .filter(
        (group) =>
          !search || group.threads.length || group.name.toLocaleLowerCase().includes(search),
      ) ?? [];
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
      {!props.collapsed && (
        <ProjectSidebar
          archived={archived}
          busy={props.busy}
          canCreate={!props.busy && !!props.workspaceId}
          query={query}
          onQuery={setQuery}
          onNew={props.onNew}
          onChoose={props.onChoose}
        >
          {groups.map((group) => (
            <ProjectGroup
              key={group.workspace.id}
              {...group}
              selected={props.workspaceId === group.workspace.id}
              threadId={props.threadId}
              busy={props.busy}
              searching={!!search}
              archived={archived}
              onWorkspace={props.onWorkspace}
              onSelect={props.onSelect}
            />
          ))}
          {!groups.length && (
            <p className="px-3 py-2 text-xs text-neutral-400">
              {search ? "没有找到匹配的项目或会话" : "打开项目，开始协作"}
            </p>
          )}
        </ProjectSidebar>
      )}
    </>
  );
}
