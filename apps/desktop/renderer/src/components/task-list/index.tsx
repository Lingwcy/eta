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
        "[--task-primary:var(--color-text-primary,#0a0a0a)] [--task-secondary:var(--color-text-secondary,#737373)] [--task-tertiary:var(--color-text-tertiary,#a3a3a3)] [--task-icon:var(--color-foreground-icon-secondary,#737373)] [--task-guide:var(--color-foreground-icon-quaternary,#d4d4d4)] [--task-border:var(--color-border-button-default,#e5e5e5)] [--task-chip-bg:var(--color-background-secondary-default,#f5f5f5)] [--task-chip-hover:var(--color-background-tertiary-default,#e5e5e5)] [--task-focus:var(--color-border-focus-ring,#a3a3a3)]",
        "[:is(.dark,[data-theme=dark])_&]:[--task-primary:var(--color-text-primary,#fafafa)] [:is(.dark,[data-theme=dark])_&]:[--task-secondary:var(--color-text-secondary,#a3a3a3)] [:is(.dark,[data-theme=dark])_&]:[--task-tertiary:var(--color-text-tertiary,#737373)] [:is(.dark,[data-theme=dark])_&]:[--task-icon:var(--color-foreground-icon-secondary,#a3a3a3)] [:is(.dark,[data-theme=dark])_&]:[--task-guide:var(--color-foreground-icon-quaternary,#404040)] [:is(.dark,[data-theme=dark])_&]:[--task-border:var(--color-border-button-default,#404040)] [:is(.dark,[data-theme=dark])_&]:[--task-chip-bg:var(--color-background-secondary-default,#262626)] [:is(.dark,[data-theme=dark])_&]:[--task-chip-hover:var(--color-background-tertiary-default,#404040)]",
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
