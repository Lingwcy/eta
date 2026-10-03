import ReactMarkdown from "react-markdown";
import type { AgentSnapshot, SnapshotTool } from "../../../../src/agent/protocol.ts";
import { TaskList } from "@/components/task-list";

export function ChatMessage({
  message,
  tools,
}: {
  message: AgentSnapshot["transcript"][number]["message"];
  tools: readonly SnapshotTool[];
}) {
  if (message.role !== "user" && message.role !== "assistant") return null;
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
  const calls =
    typeof message.content === "string"
      ? []
      : message.content.filter((content) => content.type === "toolCall");
  const messageTools = tools.filter((tool) => calls.some((call) => call.id === tool.toolCallId));
  if (!text && !messageTools.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {text &&
        (message.role === "user" ? (
          <article className="ml-auto max-w-[85%] rounded-2xl border border-neutral-200/70 bg-neutral-50 px-4 py-3 text-sm/6 whitespace-pre-wrap break-words">
            {text}
          </article>
        ) : (
          <MarkdownMessage text={text} />
        ))}
      {messageTools.length > 0 && <TaskList tools={messageTools} collapseOnComplete />}
    </div>
  );
}

export function MarkdownMessage({ text }: { text: string }) {
  return (
    <article className="text-sm/7 break-words [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-neutral-900 [&_pre]:p-4 [&_pre]:text-neutral-100 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown>{text}</ReactMarkdown>
    </article>
  );
}
