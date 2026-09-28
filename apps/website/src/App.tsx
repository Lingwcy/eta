import { useState } from "react";
import { CompositeInput } from "@/components/input";
import type { ExecutionMode } from "@/components/input";

export function App() {
  const [lastSubmission, setLastSubmission] = useState<{
    text: string;
    model: string;
    mode: ExecutionMode;
    timestamp: string;
  } | null>(null);

  const [notification, setNotification] = useState<string | null>(null);

  const showNotification = (msg: string) => {
    setNotification(msg);
    setTimeout(() => {
      setNotification((curr) => (curr === msg ? null : curr));
    }, 3000);
  };

  return (
    <main className="min-h-screen bg-[#f7f7f7] text-neutral-900 flex flex-col items-center justify-center p-4 sm:p-8 font-sans antialiased">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        {notification && (
          <div className="self-center px-4 py-1.5 rounded-full bg-neutral-900 text-white text-xs font-medium shadow-lg animate-in fade-in slide-in-from-top-2">
            {notification}
          </div>
        )}

        <CompositeInput
          placeholder="Hi, what do you need today?"
          tokenPercentage={57}
          modelName="GPT-6 Sol"
          reasoningLevel="中"
          onContextClick={() => showNotification("上下文窗口: 57% tokens 已使用")}
          onSubmit={(text, meta) => {
            setLastSubmission({
              text,
              model: meta.model,
              mode: meta.mode,
              timestamp: new Date().toLocaleTimeString(),
            });
            showNotification(`消息已分发给 ${meta.model}（模式: ${meta.mode}）`);
          }}
          onPlusClick={() => showNotification("已触发附件菜单 (+)")}
          onModelClick={() => showNotification("点击了模型选择按钮")}
          onExecutionModeChange={(mode) => showNotification(`执行模式切换为: ${mode}`)}
        />

        {lastSubmission && (
          <div className="bg-white rounded-2xl border border-neutral-200/80 p-4 shadow-sm text-sm space-y-2 animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-center justify-between text-xs text-neutral-500 font-medium">
              <span>最后一条发送消息 ({lastSubmission.timestamp})</span>
              <span className="bg-neutral-100 px-2 py-0.5 rounded-full text-neutral-700">
                {lastSubmission.model} • 模式: {lastSubmission.mode}
              </span>
            </div>
            <p className="text-neutral-800 whitespace-pre-wrap font-sans text-sm bg-neutral-50/70 p-3 rounded-xl border border-neutral-100">
              {lastSubmission.text}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
