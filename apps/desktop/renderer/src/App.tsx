import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { getThinkingLabel, getTools } from "@/agent/selectors";
import { useMemoryAgent } from "@/agent/use-memory-agent";
import { AgentThinking } from "@/components/agent-thinking";
import { CompositeInput } from "@/components/input";
import { TaskList } from "@/components/task-list";

export function App() {
  const agent = useMemoryAgent();
  const snapshot = agent.observation?.snapshot;
  const operation = snapshot?.operation;
  const running = Boolean(operation || agent.admission || agent.submitting);
  const scroll = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const messages =
    snapshot?.transcript.flatMap((entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant")
        ? [{ id: entry.id, message: entry.message }]
        : [],
    ) ?? [];
  const stream = operation?.streamingMessage;
  const tools = snapshot ? getTools(snapshot) : [];
  const failure =
    agent.error ??
    (!operation ? snapshot?.lastResult?.error?.message : undefined) ??
    (snapshot?.faulted ? "Agent 已发生错误，请新建会话。" : undefined);
  useEffect(() => {
    const element = scroll.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [snapshot]);

  return (
    <main className="flex h-dvh flex-col bg-[#f7f7f7] font-sans text-neutral-900 antialiased">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 sm:px-8">
        <span className="text-sm font-semibold">Eta</span>
        <button
          type="button"
          onClick={agent.newSession}
          className="cursor-pointer rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium transition-colors hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-neutral-400"
        >
          新建会话
        </button>
      </header>
      <div
        ref={scroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"
        onScroll={() => {
          const element = scroll.current;
          if (element)
            atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
          {!messages.length && (
            <div className="py-16 text-center text-sm text-neutral-500">
              {agent.connection === "connecting"
                ? "正在准备 Agent…"
                : "发送消息，开始与 Agent 协作。"}
            </div>
          )}
          {messages.map(({ id, message }) => {
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
            const messageTools = tools.filter((tool) =>
              calls.some((call) => call.id === tool.toolCallId),
            );
            if (!text && !messageTools.length) return null;
            return (
              <div key={id} className="flex flex-col gap-3">
                {text && (
                  <article
                    className={
                      message.role === "user"
                        ? "ml-auto max-w-[85%] rounded-2xl border border-neutral-200/70 bg-white px-4 py-3 text-sm/6 whitespace-pre-wrap break-words shadow-xs"
                        : "text-sm/7 break-words [&_pre]:my-3 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-neutral-900 [&_pre]:p-4 [&_pre]:text-neutral-100 [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
                    }
                  >
                    {message.role === "user" ? text : <ReactMarkdown>{text}</ReactMarkdown>}
                  </article>
                )}
                {messageTools.length > 0 && <TaskList tools={messageTools} collapseOnComplete />}
              </div>
            );
          })}
          {stream && (
            <article className="text-sm/7 break-words [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-neutral-900 [&_pre]:p-4 [&_pre]:text-neutral-100">
              <ReactMarkdown>
                {stream.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")}
              </ReactMarkdown>
            </article>
          )}
          {failure && (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {failure}
            </p>
          )}
          {snapshot?.lastResult?.status === "aborted" && !running && (
            <p role="status" className="text-xs text-neutral-500">
              已停止生成
            </p>
          )}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-4 sm:pb-6">
        {operation && (
          <div className="px-3 py-1">
            <AgentThinking
              variant="stars"
              label={getThinkingLabel(snapshot!)}
              startedAt={operation.startedAt}
              shimmer={false}
            />
          </div>
        )}
        <CompositeInput
          key={agent.session?.id ?? "initial"}
          model={agent.session?.model}
          thinkingLevel={snapshot?.configuration.thinkingLevel}
          contextTokens={agent.observation?.contextTokens}
          contextWindow={agent.session?.model.contextWindow}
          onSubmit={agent.submit}
          onStop={() => {
            void agent.stop();
          }}
          isRunning={running}
          isStopping={agent.stopping || operation?.status === "aborting"}
          disabled={agent.connection !== "connected" || snapshot?.faulted}
          placeholder="你想让 Agent 做什么？"
        />
      </div>
    </main>
  );
}
