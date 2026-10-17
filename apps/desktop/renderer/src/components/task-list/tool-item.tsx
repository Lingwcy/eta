import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import {
  ScheduleToolNotice,
  scheduleToolResult,
} from "@/components/schedules/schedule-tool-notice";
import { useState } from "react";
import { Clock3, CircleX, FileCode2, FilePenLine, Search, Terminal, Wrench } from "lucide-react";
import type { SnapshotTool } from "@eta/core/agent/protocol";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Reveal } from "@/components/ui/reveal";
import { ToolDetailsPanel } from "./tool-details-panel";

const toolIcons = { read: Search, edit: FilePenLine, write: FileCode2, bash: Terminal };

/** Tool details start collapsed; result updates preserve the chosen display mode. */
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
  const [open, setOpen] = useState(false);
  const failed = tool.status === "settled" && tool.isError;
  const running = tool.status === "running";
  const waiting = tool.status === "waiting";
  const preparing = tool.status === "generating" || tool.status === "pending";
  const Icon = failed ? CircleX : (toolIcons[tool.toolName as keyof typeof toolIcons] ?? Wrench);
  const label = preparing
    ? t(tool.status === "generating" ? "chat:toolItem.generating" : "chat:toolItem.pending", {
        toolName: tool.toolName,
      })
    : failed
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
  const stateLabel = t(`chat:toolItem.state.${failed ? "failed" : tool.status}`);
  return (
    <Reveal>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          variant="ghost-muted"
          size="menu-item"
          title={label}
          aria-label={`${tool.description ? `${tool.description} · ` : ""}${label} · ${t(
            "chat:toolItem.details",
            {
              value1: open ? t("chat:toolItem.collapseAll") : t("chat:toolItem.expand"),
              toolName: tool.toolName,
            },
          )}`}
        >
          <Icon size={14} aria-hidden="true" />
          <span
            className={cn("min-w-0 flex-1 truncate", failed && "text-red-600")}
            title={tool.description}
          >
            {tool.description ?? label}
          </span>
          {tool.description && tool.status !== "settled" && (
            <span className="shrink-0 text-xs">{stateLabel}</span>
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ToolDetailsPanel tool={tool} />
        </CollapsibleContent>
      </Collapsible>
    </Reveal>
  );
}
