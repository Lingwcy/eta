import { memo } from "react";
import { Reveal } from "@/components/ui/reveal";
import { MessageMarkdown } from "./message-markdown";
import type { AgentSnapshot, SnapshotTool } from "../../../../src/agent/protocol.ts";
import { TaskList } from "@/components/task-list";
import { MessageUsage } from "./message-usage";
import { ThinkingMessage } from "./thinking-message";

export function ChatMessage({
  message,
  tools,
  streaming = false,
}: {
  message: AgentSnapshot["transcript"][number]["message"];
  tools: readonly SnapshotTool[];
  streaming?: boolean;
}) {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  const images =
    typeof message.content === "string"
      ? []
      : message.content.filter((part) => part.type === "image");
  const calls =
    typeof message.content === "string"
      ? []
      : message.content.filter((content) => content.type === "toolCall");
  const messageTools = tools.filter((tool) => calls.some((call) => call.id === tool.toolCallId));
  const thinking =
    message.role === "assistant"
      ? message.content
          .filter((part) => part.type === "thinking")
          .map((part) => part.thinking)
          .filter((text) => text.trim())
          .join("\n\n")
      : "";
  if (!text && !thinking && !images.length && !messageTools.length) return null;
  return (
    <Reveal>
      <div className="flex flex-col gap-3">
        {thinking && (
          <ThinkingMessage
            text={thinking}
            active={
              streaming &&
              message.role === "assistant" &&
              message.content.at(-1)?.type === "thinking"
            }
          />
        )}
        {images.length > 0 && (
          <div className="ml-auto flex max-w-[85%] flex-wrap justify-end gap-2">
            {images.map((image, index) => (
              <img
                key={index}
                src={`data:${image.mimeType};base64,${image.data}`}
                alt={`附件图片 ${index + 1}`}
                className="max-h-56 max-w-full rounded-2xl border border-neutral-200 object-contain"
              />
            ))}
          </div>
        )}
        {text &&
          (message.role === "user" ? (
            <article className="ml-auto max-w-[85%] rounded-2xl border border-neutral-200/70 bg-neutral-50 px-4 py-3 text-sm/6 whitespace-pre-wrap break-words">
              {text}
            </article>
          ) : (
            <div className="flex flex-col gap-1">
              <MarkdownMessage text={text} />
              {(message.stopReason === "stop" || message.stopReason === "length") && (
                <MessageUsage usage={message.usage} />
              )}
            </div>
          ))}
        {messageTools.length > 0 && <TaskList tools={messageTools} />}
      </div>
    </Reveal>
  );
}

export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <article className="text-sm/7 break-words [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-neutral-900 [&_pre]:p-4 [&_pre]:text-neutral-100 [&_ul]:list-disc [&_ul]:pl-5 [&>*:last-child]:mb-0">
      <MessageMarkdown text={text} />
    </article>
  );
});
