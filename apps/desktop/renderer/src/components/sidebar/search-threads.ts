import { isCloudId } from "../../../../src/shared/bot.ts";
import { threadProjectId } from "@eta/core/shared/thread-project";
import type { DesktopLibrary } from "../../../../src/bridge.ts";

/** Searches titles and project names without opening any history runtimes. */
export function searchThreads(library: DesktopLibrary | null, query: string, archived: boolean) {
  if (!library) return [];
  const search = query.trim().toLocaleLowerCase();
  const projects = new Map(library.projects.map((project) => [project.id, project.name]));
  const workspaces = new Map(library.workspaces.map((workspace) => [workspace.id, workspace]));
  return library.threads
    .filter((thread) => (thread.archivedAt !== undefined) === archived)
    .map((thread) => {
      const workspace = workspaces.get(thread.workspaceId);
      const name = projects.get(threadProjectId(thread, library) ?? "") ?? "未分组";
      const project =
        thread.projectId === undefined && workspace?.kind === "worktree"
          ? `${name} · ${workspace.cwd.split("/").at(-1)}`
          : name;
      return { thread, project: isCloudId(thread.id) ? `云端 · ${project}` : project };
    })
    .filter(
      ({ thread, project }) =>
        !search ||
        thread.title.toLocaleLowerCase().includes(search) ||
        project.toLocaleLowerCase().includes(search),
    )
    .toSorted(
      (a, b) => b.thread.sessionRef.metadata.modifiedAt - a.thread.sessionRef.metadata.modifiedAt,
    );
}
