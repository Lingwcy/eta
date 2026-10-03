import { useEffect, useRef, type ReactNode } from "react";
import { getTools } from "@/agent/selectors";
import type { AgentSnapshot } from "../../../../src/agent/protocol.ts";
import { cn } from "@/lib/utils";
import { ChatMessage, MarkdownMessage } from "./chat-message";

export function ChatTranscript({
  snapshot,
  running,
  children,
}: {
  snapshot?: AgentSnapshot;
  running: boolean;
  children: ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const messages =
    snapshot?.transcript.filter(
      (entry) => entry.message.role === "user" || entry.message.role === "assistant",
    ) ?? [];
  const tools = snapshot ? getTools(snapshot) : [];
  const empty = !messages.length && !running;
  useEffect(() => {
    const element = scroll.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [snapshot]);
  return (
    <div
      ref={scroll}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto p-5 min-[901px]:px-8 min-[901px]:py-6",
        empty && "flex flex-col",
      )}
      onScroll={() => {
        const element = scroll.current;
        if (element)
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}
    >
      <div className={cn("mx-auto flex w-full max-w-[740px] flex-col gap-5", empty && "flex-1")}>
        {messages.map((entry) => (
          <ChatMessage key={entry.id} message={entry.message} tools={tools} />
        ))}
        {snapshot?.operation?.streamingMessage && (
          <MarkdownMessage
            text={snapshot.operation.streamingMessage.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")}
          />
        )}
        {children}
      </div>
    </div>
  );
}
