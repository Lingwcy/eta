import { expect, test } from "vite-plus/test";
import type { SubagentSummary } from "../../../../src/subagents.ts";
import { subagentTree } from "./subagent-tree";

const agent = (path: string, parent = "/root"): SubagentSummary => ({
  path,
  parent,
  conversationId: 1,
  fork: false,
  depth: 1,
  status: "completed",
});

test("groups nested agents by execution parent rather than path prefix or arrival order", () => {
  const independent = agent("/independent", "/research");
  const nested = agent("/independent/deeper", "/independent");
  const other = agent("/other");
  const parent = agent("/research");
  const sibling = agent("/research/review", "/research");
  expect(subagentTree([independent, other, nested, parent, sibling])).toEqual([
    { agent: other, children: [] },
    {
      agent: parent,
      children: [
        { agent: independent, children: [{ agent: nested, children: [] }] },
        { agent: sibling, children: [] },
      ],
    },
  ]);
});

test("keeps orphaned records visible and handles malformed cycles without recursive overflow", () => {
  const orphan = agent("/orphan", "/missing");
  const first = agent("/first", "/second");
  const second = agent("/second", "/first");
  expect(subagentTree([orphan, first, second])).toEqual([
    { agent: orphan, children: [] },
    { agent: first, children: [{ agent: second, children: [] }] },
  ]);
  expect(subagentTree([])).toEqual([]);
});
