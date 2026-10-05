import { useLayoutEffect, useState, type ReactNode } from "react";
import { getTools } from "@/agent/selectors";
import type { AgentSnapshot } from "../../../../src/agent/protocol.ts";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./chat-message";
import { getChatMessages } from "./chat-messages";
import { useScrollFollow } from "./use-scroll-follow";
import { ChatNavigation } from "./chat-navigation";
import { getActiveTurn, getChatTurns } from "./chat-turns";
import {
  ScrollAreaRoot,
  ScrollAreaViewport,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaFade,
} from "@/components/ui/scroll-area";

export function ChatTranscript({
  snapshot,
  running,
  children,
}: {
  snapshot?: AgentSnapshot;
  running: boolean;
  children: ReactNode;
}) {
  const scroll = useScrollFollow();
  const messages = getChatMessages(snapshot);
  const turns = getChatTurns(messages);
  const [activeId, setActiveId] = useState<string>();
  const updatePosition = () => {
    const viewport = scroll.viewport.current;
    if (!viewport) return;
    const anchors = [...viewport.querySelectorAll<HTMLElement>("[data-chat-turn]")];
    const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
    setActiveId(
      atBottom
        ? anchors.at(-1)?.dataset.chatTurn
        : getActiveTurn(
            anchors.map((element) => ({
              id: element.dataset.chatTurn ?? "",
              top: element.getBoundingClientRect().top,
            })),
            viewport.getBoundingClientRect().top + 48,
          ),
    );
  };
  useLayoutEffect(updatePosition, [messages.length]);
  const tools = snapshot ? getTools(snapshot) : [];
  const empty = !messages.length && !running;
  return (
    <ScrollAreaRoot className="flex-1">
      <ScrollAreaViewport
        ref={scroll.viewport}
        onScroll={() => {
          scroll.onScroll();
          updatePosition();
        }}
        className="[overflow-anchor:none]"
      >
        <ScrollAreaContent
          ref={scroll.content}
          className={cn(
            "px-5 pt-5 pb-10 min-[901px]:px-8 min-[901px]:pt-6",
            empty && "flex min-h-full flex-col",
          )}
        >
          <div
            className={cn("mx-auto flex w-full max-w-[960px] flex-col gap-5", empty && "flex-1")}
          >
            {messages.map((entry) =>
              entry.message.role === "user" ? (
                <div key={entry.id} data-chat-turn={entry.id}>
                  <ChatMessage message={entry.message} tools={tools} />
                </div>
              ) : (
                <ChatMessage
                  key={entry.id}
                  message={entry.message}
                  tools={tools}
                  streaming={entry.streaming}
                />
              ),
            )}
            {children}
          </div>
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar />
      <ScrollAreaFade edge="top" />
      <ScrollAreaFade edge="bottom" />
      <ChatNavigation
        turns={turns}
        activeId={activeId}
        onNavigate={(id) => {
          const target = [
            ...(scroll.viewport.current?.querySelectorAll<HTMLElement>("[data-chat-turn]") ?? []),
          ].find((element) => element.dataset.chatTurn === id);
          if (target) {
            scroll.jumpTo(target);
            updatePosition();
          }
        }}
      />
    </ScrollAreaRoot>
  );
}
