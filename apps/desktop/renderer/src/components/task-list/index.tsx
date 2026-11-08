import type { SnapshotTool } from "@eta/core/agent/protocol";
import { cn } from "@/lib/utils";
import { ToolItem } from "./tool-item";

export interface TaskListProps {
  tools: readonly SnapshotTool[];
  className?: string;
}

/** Renders authoritative agent tool observations; progress comes exclusively from harness events. */
export function TaskList({ tools, className }: TaskListProps) {
  const parents = new Set(tools.map((tool) => tool.parentToolCallId));
  const rows = tools.filter(
    (tool) =>
      tool.toolName !== "codemode" ||
      !parents.has(tool.toolCallId) ||
      tool.isError ||
      tool.status === "waiting" ||
      tool.result?.content.some((part) => part.type === "image"),
  );
  const visible = new Set(rows.map((tool) => tool.toolCallId));
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-0.5 font-[Inter,ui-sans-serif,system-ui,sans-serif] text-sm/5 text-(--task-secondary) antialiased",
        "[--task-primary:var(--color-task-foreground)] [--task-secondary:var(--color-subtle)] [--task-tertiary:var(--color-muted)] [--task-icon:var(--color-subtle)] [--task-guide:var(--color-disabled)] [--task-border:var(--color-border)] [--task-chip-bg:var(--color-surface-subtle)] [--task-chip-hover:var(--color-surface-hover)] [--task-focus:var(--color-focus-ring-400)]",
        className,
      )}
    >
      {rows.map((tool) => (
        <div
          key={tool.toolCallId}
          className={
            tool.parentToolCallId && visible.has(tool.parentToolCallId) ? "ml-4 min-w-0" : "min-w-0"
          }
        >
          <ToolItem tool={tool} />
        </div>
      ))}
    </div>
  );
}
