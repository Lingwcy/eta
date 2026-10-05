import { useId, useState } from "react";
import { Brain, ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RunningIndicator } from "@/components/ui/running-indicator";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
} from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useScrollFollow } from "./use-scroll-follow";

/** Keeps the chosen open state when a streamed thought becomes saved history. */
export function ThinkingMessage({ text, active }: { text: string; active: boolean }) {
  const [mode, setMode] = useState<"preview" | "expanded" | "collapsed">("preview");
  const open = mode !== "collapsed";
  const expanded = mode === "expanded";
  const detailsId = useId();
  return (
    <Collapsible open={open} onOpenChange={(next) => setMode(next ? "preview" : "collapsed")}>
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <CollapsibleTrigger
            variant="ghost-muted"
            size="row-sm"
            aria-label={`${open ? "收起" : "展开"}思考内容`}
          >
            <Brain size={16} aria-hidden="true" />
            <span className="min-w-0 flex-1 text-left">{active ? "正在思考" : "思考内容"}</span>
            {active && <RunningIndicator />}
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
          aria-label={expanded ? "返回思考预览" : "展开思考详情"}
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
        <ThinkingOutput key={mode} text={text} expanded={expanded} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Only explicit detail mode accepts wheel input; the preview follows output programmatically. */
function ThinkingOutput({ text, expanded }: { text: string; expanded: boolean }) {
  const scroll = useScrollFollow();
  const content = <div className="py-1 text-xs/5 whitespace-pre-wrap break-words">{text}</div>;
  return (
    <div className="mt-0.5 ml-2 border-l border-neutral-200 pl-4 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      {expanded ? (
        <ScrollAreaRoot>
          <ScrollAreaViewport
            ref={scroll.viewport}
            onScroll={scroll.onScroll}
            aria-label="思考内容"
            className="max-h-60"
          >
            <ScrollAreaContent ref={scroll.content}>{content}</ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar />
        </ScrollAreaRoot>
      ) : (
        <div ref={scroll.viewport} className="max-h-40 overflow-hidden pr-3">
          <div ref={scroll.content}>{content}</div>
        </div>
      )}
    </div>
  );
}
