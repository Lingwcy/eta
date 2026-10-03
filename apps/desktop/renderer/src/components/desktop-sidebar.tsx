import { useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";

interface Props {
  library: DesktopLibrary | null;
  workspaceId: string | null;
  threadId: string | null;
  busy: boolean;
  onWorkspace: (id: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onChoose: () => void;
  onSettings: () => void;
}

export function DesktopSidebar(props: Props) {
  const [archived, setArchived] = useState(false);
  const threads =
    props.library?.threads
      .filter(
        (thread) =>
          thread.workspaceId === props.workspaceId &&
          (thread.archivedAt !== undefined) === archived,
      )
      .toSorted((a, b) => b.sessionRef.metadata.modifiedAt - a.sessionRef.metadata.modifiedAt) ??
    [];
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 p-3">
      <h1 className="mb-4 text-sm font-semibold">Eta</h1>
      <label className="text-xs text-neutral-500" htmlFor="workspace">
        项目 / 工作区
      </label>
      <select
        id="workspace"
        value={props.workspaceId ?? ""}
        onChange={(event) => props.onWorkspace(event.target.value)}
        className="mt-2 min-w-0 rounded-lg border border-neutral-200 bg-white p-2 text-xs"
        disabled={props.busy}
      >
        {!props.workspaceId && <option value="">选择工作区</option>}
        {props.library?.workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {props.library?.projects.find((project) => project.id === workspace.projectId)?.name ??
              "项目"}
            {workspace.kind === "worktree" ? ` · ${workspace.cwd.split("/").at(-1)}` : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={props.onChoose}
        disabled={props.busy}
        className="mt-2 rounded-lg border border-neutral-200 bg-white p-2 text-xs disabled:opacity-50"
      >
        打开项目目录
      </button>
      <button
        type="button"
        onClick={props.onNew}
        disabled={props.busy || !props.workspaceId}
        className="mt-2 rounded-lg bg-neutral-900 p-2 text-xs text-white disabled:opacity-50"
      >
        新建会话
      </button>
      <div className="my-4 flex gap-3 text-xs">
        <button
          type="button"
          aria-pressed={!archived}
          onClick={() => setArchived(false)}
          className={!archived ? "font-semibold" : "text-neutral-500"}
        >
          历史
        </button>
        <button
          type="button"
          aria-pressed={archived}
          onClick={() => setArchived(true)}
          className={archived ? "font-semibold" : "text-neutral-500"}
        >
          已归档
        </button>
      </div>
      <nav aria-label="会话历史" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {threads.map((thread) => (
          <button
            type="button"
            key={thread.id}
            onClick={() => props.onSelect(thread.id)}
            aria-current={props.threadId === thread.id ? "page" : undefined}
            title={thread.title}
            className={`w-full truncate rounded-lg px-3 py-2 text-left text-xs ${props.threadId === thread.id ? "bg-neutral-200 font-medium" : "hover:bg-neutral-100"}`}
          >
            {thread.title || "无标题会话"}
          </button>
        ))}
        {!threads.length && (
          <p className="px-2 text-xs text-neutral-400">
            {archived ? "没有归档会话" : "没有会话历史"}
          </p>
        )}
      </nav>
      <button
        type="button"
        onClick={props.onSettings}
        className="mt-3 rounded-lg border border-neutral-200 bg-white p-2 text-xs"
      >
        设置 / 模型与认证
      </button>
    </aside>
  );
}
