import { defineDoc, defineEntry } from "@eta/agent";
import type { ConversationId, EntryId, TaskId } from "@eta/agent";
import type { SubagentSummary } from "../../../shared/subagents.ts";

// Session scope separates the execution tree from transcript ancestry, including independent children.
export type Child = {
  path: string;
  parent: string;
  conversationId: ConversationId;
  depth: number;
  fork: boolean;
  paused: boolean;
  active: TaskId[];
  pending: TaskId[];
  settling?: TaskId[];
  reported: EntryId[];
  status: SubagentSummary["status"];
  model: { provider: string; modelId: string };
  error?: string;
  canDelegate?: boolean;
  progress?: { message: string; timestamp: number };
  output?: string;
  steering?: TaskId[];
  submissionFor?: TaskId;
  timeoutTask?: TaskId;
  stopping?: boolean;
};
export type SubagentEvent = "progress" | "completed" | "failed" | "stopped" | "timeout";
export const SubagentEventEntry = defineEntry<{
  path: string;
  event: SubagentEvent;
}>("eta.subagent-event");
export const SubagentsDoc = defineDoc<{
  stopping: boolean;
  revision: number;
  agents: Child[];
  requests: Record<string, string>;
  waiters?: { conversationId: ConversationId; taskId: TaskId }[];
}>({
  kind: "eta.subagents",
  version: 1,
  scope: "session",
  initial: () => ({ stopping: false, revision: 0, agents: [], requests: {} }),
});

export function childPath(
  parent: string,
  name: string,
  fork: boolean,
  invalid: (message: string) => never,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) invalid("智能体名称只能包含字母、数字、下划线和连字符");
  if (!fork && name === "root") invalid("/root 保留给主智能体");
  return fork ? `${parent}/${name}` : `/${name}`;
}

export function isDescendant(child: Child, parent: string, agents: Child[]): boolean {
  let cursor = child.parent;
  const seen = new Set<string>();
  while (cursor !== "/root" && !seen.has(cursor)) {
    if (cursor === parent) return true;
    seen.add(cursor);
    cursor = agents.find((agent) => agent.path === cursor)?.parent ?? "/root";
  }
  return false;
}
