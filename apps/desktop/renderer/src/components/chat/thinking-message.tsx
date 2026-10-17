import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useState } from "react";
import { Brain } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
} from "@/components/ui/scroll-area";
import { useScrollFollow } from "./use-scroll-follow";

/** Keeps the chosen open state when a streamed thought becomes saved history. */
export function ThinkingMessage({ text, active }: { text: string; active: boolean }) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const preview =
    text.trim().split(/\r\n|\r|\n/, 1)[0] || t("chat:thinkingMessage.thinkingContent2");
  const title = open ? t("chat:thinkingMessage.thinkingContent2") : preview;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        variant="ghost-muted"
        size="menu-item"
        title={title}
        aria-label={`${title} · ${t("chat:thinkingMessage.thinkingContent", {
          value1: open ? t("chat:thinkingMessage.collapse") : t("chat:thinkingMessage.expand"),
        })}`}
      >
        <Brain size={14} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {active && <span className="shrink-0 text-xs">{t("chat:thinkingMessage.thinking")}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ThinkingOutput text={text} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Expanded thinking follows new output until the reader scrolls upward. */
function ThinkingOutput({ text }: { text: string }) {
  useTranslation();
  const scroll = useScrollFollow();
  return (
    <div className="mt-0.5 ml-2 text-neutral-500 dark:text-neutral-400">
      <ScrollAreaRoot className="max-h-60">
        <ScrollAreaViewport
          ref={scroll.viewport}
          onScroll={scroll.onScroll}
          className="max-h-60"
          role="region"
          aria-label={t("chat:thinkingMessage.thinkingContent2")}
        >
          <ScrollAreaContent ref={scroll.content}>
            <div className="py-1 text-xs/5 whitespace-pre-wrap break-words">{text}</div>
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar />
      </ScrollAreaRoot>
    </div>
  );
}
