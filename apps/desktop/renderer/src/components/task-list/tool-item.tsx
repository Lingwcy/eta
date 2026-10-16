import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import {
  ScheduleToolNotice,
  scheduleToolResult,
} from "@/components/schedules/schedule-tool-notice";
import { useContext, useEffect, useId, useState } from "react";
import {
  ChevronDown,
  Clock3,
  CircleCheck,
  CircleMinus,
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
import type { SnapshotTool } from "@eta/core/agent/protocol";
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
  useTranslation();
  const schedule = scheduleToolResult(tool);
  if (schedule) return <ScheduleToolNotice result={schedule} />;
  if (tool.toolName === "schedule" && tool.args.action !== "list" && tool.status === "running")
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-neutral-500">
        <Clock3 size={14} aria-hidden="true" />
        <span>
          {t("chat:toolItem.processingScheduledTask")}
          {typeof tool.args.name === "string" ? ` · ${tool.args.name}` : ""}
        </span>
      </div>
    );
  return <GenericToolItem tool={tool} />;
}

function GenericToolItem({ tool }: { tool: SnapshotTool }) {
  useTranslation();
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
  const waiting = tool.status === "waiting";
  const StateIcon = running
    ? LoaderCircle
    : failed
      ? CircleX
      : tool.status === "incomplete" || tool.status === "stopped" || waiting
        ? CircleMinus
        : CircleCheck;
  const Icon = toolIcons[tool.toolName as keyof typeof toolIcons] ?? Wrench;
  const label = failed
    ? t("chat:toolItem.failed", { toolName: tool.toolName })
    : waiting
      ? t("chat:toolItem.awaitingApproval", { toolName: tool.toolName })
      : tool.status === "settled"
        ? t("chat:toolItem.completed", { toolName: tool.toolName })
        : running
          ? t("chat:toolItem.running", { toolName: tool.toolName })
          : tool.status === "stopped"
            ? t("chat:toolItem.stopped", { toolName: tool.toolName })
            : t("chat:toolItem.noResultRecorded", { toolName: tool.toolName });
  return (
    <Reveal>
      <Collapsible open={open} onOpenChange={(next) => setMode(next ? "preview" : "collapsed")}>
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <CollapsibleTrigger
              variant="ghost-muted"
              size="row-sm"
              aria-label={t("chat:toolItem.details", {
                value1: open ? t("chat:toolItem.collapseAll") : t("chat:toolItem.expand"),
                toolName: tool.toolName,
              })}
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
            aria-label={
              expanded
                ? t("chat:toolItem.backToPreview", { toolName: tool.toolName })
                : t("chat:toolItem.expandDetails", { toolName: tool.toolName })
            }
            title={expanded ? t("chat:toolItem.backToPreview2") : t("chat:toolItem.expandDetails2")}
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
