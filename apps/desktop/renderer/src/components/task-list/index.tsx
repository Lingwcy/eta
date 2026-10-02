import { useId, useState } from "react";
import { FileCode2, FilePenLine, Search, Terminal, Wrench } from "lucide-react";
import type { SnapshotTool } from "../../../../src/agent/protocol.ts";
import { cn } from "@/lib/utils";
import "./task-list.css";

const revealClassName =
  "grid grid-rows-[1fr] animate-[eta-task-reveal_440ms_cubic-bezier(0.22,1,0.36,1)_both] motion-reduce:animate-none";
const contentClassName = "min-h-0 min-w-0 overflow-hidden";
const shimmerClassName =
  "text-transparent bg-[linear-gradient(100deg,var(--task-secondary)_16%,var(--task-secondary)_38%,var(--task-primary)_50%,var(--task-secondary)_62%,var(--task-secondary)_84%)] bg-size-[300%_100%] bg-position-[200%_0] bg-clip-text animate-[eta-task-shimmer_3.4s_linear_1] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-(--task-secondary)";

export interface TaskListProps {
  tools: readonly SnapshotTool[];
  collapseOnComplete?: boolean;
  className?: string;
}

const toolIcons = { read: Search, edit: FilePenLine, write: FileCode2, bash: Terminal };

function ToolItem({
  tool,
  collapseOnComplete,
}: {
  tool: SnapshotTool;
  collapseOnComplete: boolean;
}) {
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const detailsId = useId();
  const settled = tool.status === "settled";
  const failed = settled && tool.isError;
  const open = openOverride ?? !(collapseOnComplete && settled);
  const Icon = toolIcons[tool.toolName as keyof typeof toolIcons] ?? Wrench;
  const label = failed
    ? `${tool.toolName} · 失败`
    : settled
      ? tool.toolName
      : `正在执行 ${tool.toolName}`;
  const resource =
    tool.args &&
    typeof tool.args === "object" &&
    "path" in tool.args &&
    typeof tool.args.path === "string"
      ? tool.args.path
      : undefined;
  const output = tool.result?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = tool.result?.content.filter((part) => part.type === "image") ?? [];
  const hasOutput = Boolean(output || images.length);

  return (
    <section className={revealClassName}>
      <div className={contentClassName}>
        <button
          type="button"
          className="group flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent py-0.5 text-left text-sm/5 font-medium text-inherit focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--task-focus)"
          onClick={() => setOpenOverride(!open)}
          aria-expanded={open}
          aria-controls={detailsId}
        >
          <Icon className="block size-4 shrink-0 text-(--task-icon)" aria-hidden="true" />
          <span className="min-w-0 flex-1 overflow-hidden">
            <span
              key={label}
              className={cn(
                "block truncate",
                !settled && shimmerClassName,
                failed && "text-red-600",
              )}
            >
              {label}
            </span>
          </span>
          <svg
            className="block size-4 shrink-0 text-(--task-tertiary) transition-transform duration-300 data-[open=true]:rotate-180 motion-reduce:transition-none"
            data-open={open}
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <path d="m12 13.17 4.95-4.95 1.41 1.42L12 16 5.64 9.64l1.41-1.42Z" />
          </svg>
        </button>
        <div
          className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] data-[open=true]:grid-rows-[1fr] data-[open=true]:opacity-100 motion-reduce:transition-none"
          data-open={open}
          id={detailsId}
          inert={!open}
          aria-hidden={!open}
        >
          <div className={contentClassName}>
            <ul className="mt-0.5 ml-2 flex list-none flex-col p-0">
              <li className="relative py-1 pl-4">
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 w-3 text-(--task-guide)"
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
                  {hasOutput && <span className="absolute top-2 bottom-0 left-0 w-px bg-current" />}
                </span>
                {resource ? (
                  <div className="flex min-w-0 items-center">
                    <span>文件</span>
                    <span
                      className="ml-[3px] inline-flex min-w-0 -translate-y-px items-center gap-1 rounded-md border border-(--task-border)/50 bg-(--task-chip-bg) px-1.5 py-0.5 text-(--task-primary)"
                      title={resource}
                    >
                      <FileCode2 className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate text-[11px]/[15px] font-medium tracking-[0.2px]">
                        {resource}
                      </span>
                    </span>
                  </div>
                ) : (
                  <span>参数</span>
                )}
                <pre className="mt-1 max-h-48 overflow-auto font-mono text-xs/5 whitespace-pre-wrap break-words">
                  {JSON.stringify(tool.args, null, 2)}
                </pre>
              </li>
              {hasOutput && (
                <li className={cn(revealClassName, "relative py-1 pl-4")}>
                  <div className={contentClassName}>
                    <svg
                      className="pointer-events-none absolute top-0 left-0 text-(--task-guide)"
                      width="12"
                      height="15"
                      viewBox="0 0 12 15"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M0.5 0V8Q0.5 14 6.5 14H11.5" stroke="currentColor" />
                    </svg>
                    {output && (
                      <pre
                        className={cn(
                          "max-h-64 overflow-auto font-mono text-xs/5 whitespace-pre-wrap break-words",
                          failed && "text-red-600",
                        )}
                      >
                        {output}
                      </pre>
                    )}
                    {images.map((image, index) => (
                      <img
                        key={index}
                        src={`data:${image.mimeType};base64,${image.data}`}
                        alt={`${tool.toolName} 图片结果`}
                        className="mt-2 max-h-64 max-w-full rounded-lg object-contain"
                      />
                    ))}
                  </div>
                </li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Renders authoritative agent tool observations; progress comes exclusively from harness events. */
export function TaskList({ tools, collapseOnComplete = false, className }: TaskListProps) {
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-[5px] font-[Inter,ui-sans-serif,system-ui,sans-serif] text-sm/5 text-(--task-secondary) antialiased",
        "[--task-primary:var(--color-text-primary,#0a0a0a)] [--task-secondary:var(--color-text-secondary,#737373)] [--task-tertiary:var(--color-text-tertiary,#a3a3a3)] [--task-icon:var(--color-foreground-icon-secondary,#737373)] [--task-guide:var(--color-foreground-icon-quaternary,#d4d4d4)] [--task-border:var(--color-border-button-default,#e5e5e5)] [--task-chip-bg:var(--color-background-secondary-default,#f5f5f5)] [--task-chip-hover:var(--color-background-tertiary-default,#e5e5e5)] [--task-focus:var(--color-border-focus-ring,#a3a3a3)]",
        "[:is(.dark,[data-theme=dark])_&]:[--task-primary:var(--color-text-primary,#fafafa)] [:is(.dark,[data-theme=dark])_&]:[--task-secondary:var(--color-text-secondary,#a3a3a3)] [:is(.dark,[data-theme=dark])_&]:[--task-tertiary:var(--color-text-tertiary,#737373)] [:is(.dark,[data-theme=dark])_&]:[--task-icon:var(--color-foreground-icon-secondary,#a3a3a3)] [:is(.dark,[data-theme=dark])_&]:[--task-guide:var(--color-foreground-icon-quaternary,#404040)] [:is(.dark,[data-theme=dark])_&]:[--task-border:var(--color-border-button-default,#404040)] [:is(.dark,[data-theme=dark])_&]:[--task-chip-bg:var(--color-background-secondary-default,#262626)] [:is(.dark,[data-theme=dark])_&]:[--task-chip-hover:var(--color-background-tertiary-default,#404040)]",
        className,
      )}
    >
      {tools.map((tool) => (
        <ToolItem key={tool.toolCallId} tool={tool} collapseOnComplete={collapseOnComplete} />
      ))}
    </div>
  );
}
