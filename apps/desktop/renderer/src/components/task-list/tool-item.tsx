import { useContext, useEffect, useId, useState } from "react";
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  FileCode2,
  FilePenLine,
  Maximize2,
  LoaderCircle,
  Minimize2,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { SnapshotTool } from "../../../../src/agent/protocol.ts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EntranceAnimation, Reveal } from "@/components/ui/reveal";
import { Shimmer } from "@/components/ui/shimmer";
import { ToolDetailsPanel } from "./tool-details-panel";

const toolIcons = { read: Search, edit: FilePenLine, write: FileCode2, bash: Terminal };
type DetailMode = "preview" | "expanded" | "collapsed";

/** New tool calls open once; result updates never override the chosen display mode. */
export function ToolItem({ tool }: { tool: SnapshotTool }) {
  const [mode, setMode] = useState<DetailMode>("preview");
  const animate = useContext(EntranceAnimation);
  const [entered, setEntered] = useState(!animate);
  const detailsId = useId();
  useEffect(() => {
    if (!animate) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [animate]);
  const open = entered && mode !== "collapsed";
  const expanded = mode === "expanded";
  const failed = tool.status === "settled" && tool.isError;
  const running = tool.status === "running";
  const StateIcon = running ? LoaderCircle : failed ? CircleX : CircleCheck;
  const Icon = toolIcons[tool.toolName as keyof typeof toolIcons] ?? Wrench;
  const label = failed
    ? `${tool.toolName} · 失败`
    : tool.status === "settled"
      ? `${tool.toolName} · 已完成`
      : `正在执行 ${tool.toolName}`;
  return (
    <Reveal>
      <Collapsible open={open} onOpenChange={(next) => setMode(next ? "preview" : "collapsed")}>
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <CollapsibleTrigger
              variant="ghost-muted"
              size="row-sm"
              aria-label={`${open ? "全部收起" : "展开"} ${tool.toolName} 详情`}
            >
              <Icon size={16} aria-hidden="true" />
              <span className={cn("min-w-0 flex-1 truncate", failed && "text-red-600")}>
                <Shimmer active={running}>{label}</Shimmer>
              </span>
              <StateIcon
                size={15}
                aria-hidden="true"
                className={cn(
                  "shrink-0",
                  running && "animate-spin motion-reduce:animate-none",
                  failed && "text-red-600",
                )}
              />
              <ChevronDown
                size={15}
                aria-hidden="true"
                className={cn(
                  "shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                  open && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
          </div>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-controls={detailsId}
            aria-pressed={expanded}
            aria-label={expanded ? `返回 ${tool.toolName} 预览` : `展开 ${tool.toolName} 详情`}
            title={expanded ? "返回预览" : "展开详情"}
            onClick={() => setMode(expanded ? "preview" : "expanded")}
          >
            {expanded ? (
              <Minimize2 size={14} aria-hidden="true" />
            ) : (
              <Maximize2 size={14} aria-hidden="true" />
            )}
          </Button>
        </div>
        <CollapsibleContent id={detailsId}>
          <ToolDetailsPanel tool={tool} expanded={expanded} />
        </CollapsibleContent>
      </Collapsible>
    </Reveal>
  );
}
