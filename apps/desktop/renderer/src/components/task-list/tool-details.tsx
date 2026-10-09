import type { ReactNode } from "react";
import { FileCode2 } from "lucide-react";
import type { SnapshotTool } from "@eta/core/agent/protocol";
import { cn } from "@/lib/utils";

function ToolBranch({ children, continued = false }: { children: ReactNode; continued?: boolean }) {
  return (
    <li className="relative min-w-0 py-1 pl-4">
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
        {continued && <span className="absolute top-2 bottom-0 left-0 w-px bg-current" />}
      </span>
      {children}
    </li>
  );
}

export function ToolDetails({ tool }: { tool: SnapshotTool }) {
  const resource = typeof tool.args.path === "string" ? tool.args.path : undefined;
  const output = tool.result?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = tool.result?.content.filter((part) => part.type === "image") ?? [];
  const hasOutput = Boolean(output || images.length);
  return (
    <ul className="mt-0.5 ml-2 flex min-w-0 list-none flex-col p-0">
      <ToolBranch continued={hasOutput}>
        {resource ? (
          <div className="flex min-w-0 items-center gap-1">
            <span>文件</span>
            <span
              className="inline-flex min-w-0 items-center gap-1 rounded-md border border-(--task-border)/50 bg-(--task-chip-bg) px-1.5 py-0.5 text-(--task-primary)"
              title={resource}
            >
              <FileCode2 size={14} className="shrink-0" aria-hidden="true" />
              <span className="truncate text-[11px]/[15px] font-medium">{resource}</span>
            </span>
          </div>
        ) : (
          <span>参数</span>
        )}
        <pre className="mt-1 font-mono text-xs/5 whitespace-pre-wrap break-words">
          {JSON.stringify(tool.args, null, 2)}
        </pre>
      </ToolBranch>
      {hasOutput && (
        <ToolBranch>
          {output && (
            <pre
              className={cn(
                "font-mono text-xs/5 whitespace-pre-wrap break-words",
                tool.isError && "text-red-600",
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
        </ToolBranch>
      )}
    </ul>
  );
}
