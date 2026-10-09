import type { SubagentSummary } from "../../../../src/shared/subagents.ts";

export type SubagentNode = { agent: SubagentSummary; children: SubagentNode[] };

/** Execution parents define the tree, including children whose independent paths contain no ancestry. */
export function subagentTree(agents: readonly SubagentSummary[]) {
  const paths = new Set(agents.map((agent) => agent.path));
  const children = new Map<string, SubagentSummary[]>();
  for (const agent of agents) {
    const siblings = children.get(agent.parent) ?? [];
    siblings.push(agent);
    children.set(agent.parent, siblings);
  }
  const visited = new Set<string>();
  const visit = (agent: SubagentSummary): SubagentNode => {
    visited.add(agent.path);
    return {
      agent,
      children: (children.get(agent.path) ?? [])
        .filter((child) => !visited.has(child.path))
        .map(visit),
    };
  };
  const roots = agents.filter((agent) => !paths.has(agent.parent)).map(visit);
  // Preserve visible records if a partial snapshot is missing a parent or contains a cycle.
  for (const agent of agents) if (!visited.has(agent.path)) roots.push(visit(agent));
  return roots;
}
