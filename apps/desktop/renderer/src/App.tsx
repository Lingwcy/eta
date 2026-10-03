import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { getThinkingLabel, getTools } from "@/agent/selectors";
import { useThreadAgent } from "@/agent/use-thread-agent";
import { useDesktopLibrary } from "@/agent/use-desktop-library";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { DesktopSettings } from "@/components/desktop-settings";
import { AgentThinking } from "@/components/agent-thinking";
import { CompositeInput } from "@/components/input";
import { TaskList } from "@/components/task-list";

export function App() {
  const desktop = useDesktopLibrary();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const [editingTitle, setEditingTitle] = useState<{ id: string; title: string } | null>(null);
  const reconnect = () => setVersion((current) => current + 1);
  const agent = useThreadAgent(desktop.threadId, version);
  const thread = desktop.library?.threads.find((thread) => thread.id === desktop.threadId);
  const snapshot = agent.observation?.snapshot;
  const operation = snapshot?.operation;
  const running = Boolean(
    ((operation || snapshot?.compacting) && !snapshot?.recoveryRequired) ||
    agent.admission ||
    agent.submitting,
  );
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
    desktop.error ??
    agent.error ??
    snapshot?.blockedReason ??
    (!operation ? snapshot?.lastResult?.error?.message : undefined) ??
    (snapshot?.faulted ? "Agent 已发生错误，请新建会话。" : undefined);
  useEffect(() => {
    const element = scroll.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [snapshot]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        void desktop.newThread();
      }
      if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktop.newThread]);

  return (
    <div className="relative flex h-dvh bg-[#f7f7f7] font-sans text-neutral-900 antialiased">
      <DesktopSidebar
        library={desktop.library}
        workspaceId={desktop.workspaceId}
        threadId={desktop.threadId}
        busy={desktop.busy}
        onWorkspace={desktop.selectWorkspace}
        onSelect={desktop.select}
        onNew={() => void desktop.newThread()}
        onChoose={() => void desktop.chooseProject()}
        onSettings={() => setSettingsOpen(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 sm:px-8">
          <span className="min-w-0 truncate text-sm font-semibold">
            {thread?.title ?? "选择或新建会话"}
          </span>
          {thread && (
            <div className="flex shrink-0 gap-3 text-xs">
              <button
                type="button"
                disabled={desktop.busy}
                onClick={() => setEditingTitle({ id: thread.id, title: thread.title })}
              >
                重命名
              </button>
              <button
                type="button"
                disabled={desktop.busy || running || !!snapshot?.recoveryRequired}
                onClick={() =>
                  void desktop.act(async () => {
                    await window.eta.archiveThread(thread.id, thread.archivedAt === undefined);
                    reconnect();
                  })
                }
              >
                {thread.archivedAt === undefined ? "归档" : "恢复归档"}
              </button>
              <button
                type="button"
                disabled={
                  desktop.busy ||
                  running ||
                  !!snapshot?.recoveryRequired ||
                  !!snapshot?.blockedReason
                }
                onClick={() =>
                  void desktop.act(async () => {
                    await window.eta.compact(thread.id);
                  })
                }
              >
                压缩上下文
              </button>
            </div>
          )}
        </header>
        {editingTitle?.id === thread?.id && editingTitle && (
          <form
            className="flex gap-3 border-b border-neutral-200 px-4 py-2 text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              void desktop.act(async () => {
                await window.eta.renameThread(editingTitle.id, editingTitle.title);
                setEditingTitle(null);
              });
            }}
          >
            <input
              aria-label="会话标题"
              value={editingTitle.title}
              onChange={(event) => setEditingTitle({ ...editingTitle, title: event.target.value })}
              className="min-w-0 flex-1 rounded border border-neutral-200 bg-white px-2 py-1"
              required
            />
            <button type="submit" disabled={desktop.busy}>
              保存
            </button>
            <button type="button" onClick={() => setEditingTitle(null)}>
              取消
            </button>
          </form>
        )}
        <div
          ref={scroll}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8"
          onScroll={() => {
            const element = scroll.current;
            if (element)
              atBottom.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
            {!messages.length && (
              <div className="py-16 text-center text-sm text-neutral-500">
                {!desktop.threadId
                  ? "选择历史会话，或选择项目后新建会话。"
                  : agent.connection === "connecting"
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
            {snapshot?.recoveryRequired && desktop.threadId && (
              <div
                role="status"
                className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm"
              >
                <p>发现未完成任务。恢复可能继续执行工具；尚未自动运行。</p>
                <div className="mt-3 flex gap-4">
                  <button
                    type="button"
                    disabled={desktop.busy || !!snapshot.blockedReason}
                    onClick={() =>
                      void desktop.act(async () => {
                        await window.eta.resume(desktop.threadId!);
                        reconnect();
                      })
                    }
                  >
                    继续原任务
                  </button>
                  <button
                    type="button"
                    disabled={desktop.busy}
                    onClick={() =>
                      void desktop.act(async () => {
                        await window.eta.stop(desktop.threadId!);
                        reconnect();
                      })
                    }
                  >
                    停止原任务
                  </button>
                </div>
              </div>
            )}
            {snapshot?.lastResult?.status === "aborted" && !running && (
              <p role="status" className="text-xs text-neutral-500">
                已停止生成
              </p>
            )}
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 pb-4 sm:pb-6">
          {operation && !snapshot?.recoveryRequired && (
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
            onSubmit={async (prompt) => {
              await agent.submit(prompt);
              void desktop.refresh().catch(() => {});
            }}
            onStop={() => {
              void agent.stop();
            }}
            isRunning={running}
            isStopping={agent.stopping || operation?.status === "aborting"}
            disabled={
              !desktop.threadId ||
              agent.connection !== "connected" ||
              snapshot?.faulted ||
              !!snapshot?.blockedReason ||
              !!snapshot?.recoveryRequired
            }
            placeholder="你想让 Agent 做什么？"
          />
        </div>
      </main>
      {settingsOpen && desktop.library && (
        <DesktopSettings
          library={desktop.library}
          threadId={desktop.threadId}
          busy={desktop.busy}
          act={desktop.act}
          error={desktop.error}
          reconnect={reconnect}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
