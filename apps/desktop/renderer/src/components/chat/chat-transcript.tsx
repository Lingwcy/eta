import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getTools, indexTools, toolsForMessage } from "@/agent/selectors";
import type { AgentSnapshot } from "@eta/core/agent/protocol";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./chat-message";
import { ChatMessageState } from "./chat-message-state";
import { getChatMessages, isActivityMessage } from "./chat-messages";
import { ChatNavigation } from "./chat-navigation";
import { getChatTurns } from "./chat-turns";
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
  origins,
  active = true,
  children,
}: {
  snapshot?: AgentSnapshot;
  running: boolean;
  origins?: ReadonlyMap<string, string>;
  active?: boolean;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => getChatMessages(snapshot), [snapshot]);
  const tools = useMemo(() => indexTools(snapshot ? getTools(snapshot) : []), [snapshot]);
  const turns = useMemo(() => getChatTurns(messages), [messages]);
  const turnIndices = useMemo(
    () => messages.flatMap((entry, index) => (entry.message.role === "user" ? [index] : [])),
    [messages],
  );
  const seen = useRef<Set<string> | undefined>(undefined);
  // Restored history has no entrance; a new row animates only on its first mount.
  if (snapshot && !seen.current) seen.current = new Set(messages.map((entry) => entry.id));
  const expanded = useRef(new Set<string>());
  const started = useRef(false);
  const getItemKey = useCallback(
    // The tail key changes on append so the virtualizer recognizes new output after the last row.
    (index: number) => messages[index]?.id ?? `chat-footer:${messages.at(-1)?.id}`,
    [messages],
  );
  const virtualizer = useVirtualizer({
    count: messages.length ? messages.length + 1 : 0,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: (index) => {
      const entry = messages[index];
      if (!entry) return 64;
      return isActivityMessage(entry.message) ? 32 : 120;
    },
    overscan: 6,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 24,
    scrollPaddingStart: 24,
    useCachedMeasurements: !active,
  });
  const rows = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    if (!active || !messages.length || started.current) return;
    started.current = true;
    virtualizer.scrollToEnd();
  }, [active, messages.length, virtualizer]);
  useLayoutEffect(() => {
    for (const row of rows) {
      const entry = messages[row.index];
      if (entry) seen.current?.add(entry.id);
    }
  });
  const readingIndex = virtualizer.isAtEnd()
    ? messages.length - 1
    : (virtualizer.getVirtualItemForOffset((virtualizer.scrollOffset ?? 0) + 48)?.index ?? 0);
  // The measured list supplies positions; no full-transcript DOM queries on scroll.
  const turnIndex = findTurnIndex(turnIndices, readingIndex);
  const navigate = useCallback(
    (id: string) => {
      const index = turns.findIndex((turn) => turn.id === id);
      const messageIndex = turnIndices[index];
      if (messageIndex !== undefined) virtualizer.scrollToIndex(messageIndex, { align: "start" });
    },
    [turns, turnIndices, virtualizer],
  );
  const empty = !messages.length && !running;
  return (
    <ScrollAreaRoot className="flex-1">
      <ScrollAreaViewport ref={viewport} className="[overflow-anchor:none]">
        <ScrollAreaContent
          className={cn(
            "px-5 min-[901px]:px-8",
            !messages.length && "pt-5 pb-10 min-[901px]:pt-6",
            empty && "flex min-h-full flex-col",
          )}
        >
          <div
            className={cn(
              "relative mx-auto w-full max-w-[960px]",
              empty && "flex flex-1 flex-col gap-5",
            )}
            style={messages.length ? { height: virtualizer.getTotalSize() } : undefined}
          >
            {rows.map((row) => {
              const entry = messages[row.index];
              const previous = messages[row.index - 1];
              const compact =
                entry &&
                previous &&
                isActivityMessage(entry.message) &&
                isActivityMessage(previous.message);
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  data-chat-message={entry?.id}
                  data-chat-turn={entry?.message.role === "user" ? entry.id : undefined}
                  className={cn(
                    "absolute top-0 left-0 w-full",
                    row.index === 0 ? "pt-5 min-[901px]:pt-6" : compact ? "pt-0.5" : "pt-5",
                    !entry && "pb-10",
                  )}
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  {entry ? (
                    <ChatMessageState value={{ id: entry.id, expanded: expanded.current }}>
                      {entry.message.role === "user" && origins?.get(entry.id) && (
                        <p className="mb-1 text-right text-xs text-neutral-500">
                          {origins.get(entry.id)}
                        </p>
                      )}
                      <ChatMessage
                        message={entry.message}
                        tools={toolsForMessage(
                          tools,
                          entry.message.role === "assistant"
                            ? entry.message.content.flatMap((part) =>
                                part.type === "toolCall" ? [part.id] : [],
                              )
                            : [],
                        )}
                        streaming={entry.streaming}
                        animate={Boolean(seen.current && !seen.current.has(entry.id))}
                      />
                    </ChatMessageState>
                  ) : (
                    <div className="flex flex-col gap-5">{children}</div>
                  )}
                </div>
              );
            })}
            {!messages.length && children}
          </div>
        </ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar />
      <ScrollAreaFade edge="top" />
      <ScrollAreaFade edge="bottom" />
      <ChatNavigation turns={turns} activeId={turns[turnIndex]?.id} onNavigate={navigate} />
    </ScrollAreaRoot>
  );
}

function findTurnIndex(indices: readonly number[], messageIndex: number) {
  let low = 0;
  let high = indices.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (indices[middle]! <= messageIndex) low = middle;
    else high = middle - 1;
  }
  return low;
}
