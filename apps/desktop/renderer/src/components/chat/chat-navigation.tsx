import { useState } from "react";
import { Bookmark } from "lucide-react";
import { MessageMarkdown } from "./message-markdown";
import { Button } from "@/components/ui/button";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/components/ui/preview-card";
import { Reveal } from "@/components/ui/reveal";
import { cn } from "@/lib/utils";
import type { ChatTurn } from "./chat-turns";

const tickWidths = ["w-7", "w-5", "w-3.5", "w-2.5"];

export function ChatNavigation({
  turns,
  activeId,
  onNavigate,
}: {
  turns: ChatTurn[];
  activeId: string | undefined;
  onNavigate: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (turns.length < 2) return null;
  return (
    <PreviewCard<ChatTurn>
      onOpenChange={(open) => {
        if (!open) setHovered(null);
      }}
    >
      {({ payload }) => (
        <>
          <nav
            aria-label="会话导航"
            onPointerLeave={() => setHovered(null)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null);
            }}
            className="absolute top-1/2 left-2 z-20 hidden max-h-[70%] -translate-y-1/2 flex-col min-[901px]:flex"
          >
            {turns.map((turn, index) => {
              const distance = hovered === null ? Infinity : Math.abs(index - hovered);
              return (
                <PreviewCardTrigger
                  key={turn.id}
                  payload={turn}
                  delay={120}
                  closeDelay={180}
                  onPointerEnter={() => setHovered(index)}
                  onFocus={() => setHovered(index)}
                  render={
                    <Button
                      variant="timeline"
                      size="tick"
                      aria-label={`跳到第 ${index + 1} 轮：${turn.title}`}
                      aria-current={turn.id === activeId ? "location" : undefined}
                      onClick={() => onNavigate(turn.id)}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-0.5 w-1.5 bg-current transition-[width,color] duration-200 ease-out motion-reduce:transition-none",
                          tickWidths[distance],
                          distance === 0
                            ? "text-neutral-800"
                            : turn.id === activeId && "text-neutral-500",
                        )}
                      />
                    </Button>
                  }
                />
              );
            })}
          </nav>
          <PreviewCardContent>
            <div className="h-[108px]">
              {payload && (
                <Reveal key={payload.id}>
                  <div className="flex min-w-0 items-center gap-3">
                    <p className="min-w-0 flex-1 truncate text-[13px]/5 font-semibold text-neutral-800">
                      {payload.title}
                    </p>
                    <Bookmark size={14} className="shrink-0 text-neutral-400" aria-hidden="true" />
                  </div>
                  <div className="mt-1.5 line-clamp-4 text-xs/5 break-words text-neutral-500 [&_p]:mb-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4">
                    <MessageMarkdown text={payload.preview || "等待响应…"} />
                  </div>
                </Reveal>
              )}
            </div>
          </PreviewCardContent>
        </>
      )}
    </PreviewCard>
  );
}
