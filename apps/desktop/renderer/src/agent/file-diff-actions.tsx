import { createContext, useContext, type ReactNode } from "react";
import { Predicate } from "effect";
import type { SnapshotTool } from "@eta/core/agent/protocol";

export interface FileDiffSelection {
  threadId: string;
  workspaceId?: string;
  changeId: string;
  path: string;
}

const FileDiffContext = createContext<{
  threadId: string;
  workspaceId?: string;
  onOpen: (selection: FileDiffSelection) => void;
} | null>(null);

/** Bind tool actions to their conversation, including a selected child conversation. */
export function FileDiffActions({
  threadId,
  workspaceId,
  onOpen,
  children,
}: {
  threadId?: string;
  workspaceId?: string;
  onOpen?: (selection: FileDiffSelection) => void;
  children: ReactNode;
}) {
  return (
    <FileDiffContext.Provider value={threadId && onOpen ? { threadId, workspaceId, onOpen } : null}>
      {children}
    </FileDiffContext.Provider>
  );
}

export function fileChangeTarget(tool: SnapshotTool) {
  const details = tool.result?.details;
  const reference = Predicate.isObject(details) ? details.fileChange : undefined;
  if (
    Predicate.isObject(reference) &&
    typeof reference.id === "string" &&
    typeof reference.path === "string"
  )
    return {
      changeId: reference.id,
      path: reference.path || (typeof tool.args.path === "string" ? tool.args.path : ""),
    };
  if (
    (tool.toolName === "edit" || tool.toolName === "write") &&
    tool.status === "settled" &&
    tool.result &&
    !tool.isError
  )
    return {
      changeId: "not-recorded",
      path: typeof tool.args.path === "string" ? tool.args.path : "",
    };
  return undefined;
}

export function useFileChangeAction(tool: SnapshotTool) {
  const actions = useContext(FileDiffContext);
  const target = fileChangeTarget(tool);
  if (!actions || !target) return undefined;
  return () =>
    actions.onOpen({ threadId: actions.threadId, workspaceId: actions.workspaceId, ...target });
}
