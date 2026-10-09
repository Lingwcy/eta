import type { ReactNode } from "react";
import { Check, CircleDot, Clock3, CirclePause, CircleAlert, CircleMinus } from "lucide-react";
import type { SubagentSummary } from "../../../../src/shared/subagents.ts";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SlidingLabel } from "@/components/sidebar/sliding-label";
import { subagentTree } from "./subagent-tree";
import type { SubagentNode } from "./subagent-tree";
import { subagentStatus } from "./subagent-status";

const statusIcons = {
  running: CircleDot,
  queued: Clock3,
  paused: CirclePause,
  completed: Check,
  failed: CircleAlert,
  stopped: CircleMinus,
};

export function SubagentControls({
  agents,
  onSelect,
  selected,
}: {
  agents: readonly SubagentSummary[];
  selected?: string;
  onSelect: (path: string) => void;
}) {
  const renderNodes = (nodes: SubagentNode[], nested = false): ReactNode => (
    <ul className={nested ? "ml-2 min-w-0 list-none p-0" : "min-w-0 list-none p-0"}>
      {nodes.map(({ agent: child, children }, index) => {
        const StatusIcon = statusIcons[child.status];
        const label = `${child.path} · ${subagentStatus[child.status]}${child.progress ? ` · ${child.progress.message}` : ""}`;
        return (
          <li key={child.path} className={nested ? "relative min-w-0 pl-4" : "min-w-0"}>
            {nested && (
              <span
                className="pointer-events-none absolute inset-y-0 left-0 w-3 text-neutral-300"
                aria-hidden="true"
              >
                <svg
                  className="absolute top-0 left-0"
                  width="12"
                  height="15"
                  viewBox="0 0 12 15"
                  fill="none"
                >
                  <path d="M0.5 0V8Q0.5 14 6.5 14H11.5" stroke="currentColor" />
                </svg>
                {index < nodes.length - 1 && (
                  <span className="absolute top-2 bottom-0 left-0 w-px bg-current" />
                )}
              </span>
            )}
            <div className="min-w-0 pb-0.5">
              <Button
                variant="ghost"
                size="row-compact"
                selected={selected === child.path}
                aria-current={selected === child.path ? "page" : undefined}
                aria-label={label}
                title={label}
                onClick={() => onSelect(child.path)}
              >
                <SlidingLabel text={child.path.split("/").at(-1) ?? child.path} />
                <span
                  className="flex shrink-0 items-center gap-1 text-xs text-neutral-400"
                  aria-hidden="true"
                >
                  {child.status === "stopped" && subagentStatus.stopped}
                  <StatusIcon size={13} />
                </span>
              </Button>
            </div>
            {children.length > 0 && renderNodes(children, true)}
          </li>
        );
      })}
    </ul>
  );
  return (
    <ScrollArea gutter="overlay" className="flex-1">
      <nav aria-label="子智能体" className="p-2">
        {renderNodes(subagentTree(agents))}
      </nav>
    </ScrollArea>
  );
}
