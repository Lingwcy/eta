import { useState } from "react";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { ThinkingLevel } from "../../../src/agent/protocol.ts";

interface Props {
  library: DesktopLibrary;
  threadId: string | null;
  busy: boolean;
  error: string | null;
  act(action: () => Promise<void>): Promise<void>;
  reconnect(): void;
  onClose: () => void;
}

export function DesktopSettings(props: Props) {
  const [modelKey, setModelKey] = useState(
    `${props.library.settings.defaultProvider ?? props.library.models[0]?.provider ?? ""}/${props.library.settings.defaultModel ?? props.library.models[0]?.id ?? ""}`,
  );
  const [thinking, setThinking] = useState<ThinkingLevel>(
    props.library.settings.defaultThinkingLevel,
  );
  const [provider, setProvider] = useState(props.library.models[0]?.provider ?? "");
  const [apiKey, setApiKey] = useState("");
  const model = props.library.models.find((model) => `${model.provider}/${model.id}` === modelKey);
  const fieldClass = "w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm";
  return (
    <section
      aria-label="设置"
      className="absolute inset-y-0 right-0 z-10 w-full max-w-md overflow-y-auto border-l border-neutral-200 bg-white p-6 shadow-xl"
    >
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-semibold">模型与认证</h2>
        <button type="button" onClick={props.onClose} aria-label="关闭设置">
          关闭
        </button>
      </div>
      {props.error && (
        <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {props.error}
        </p>
      )}
      <label className="block text-sm">
        可用模型
        <select
          className={`${fieldClass} mt-2`}
          value={modelKey}
          onChange={(event) => setModelKey(event.target.value)}
        >
          <option value="">选择模型</option>
          {props.library.models.map((model) => (
            <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
              {model.provider} / {model.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-4 block text-sm">
        思考级别
        <select
          className={`${fieldClass} mt-2`}
          value={thinking}
          onChange={(event) => setThinking(event.target.value as ThinkingLevel)}
        >
          {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled={props.busy || !model}
          className="rounded-lg bg-neutral-900 px-3 py-2 text-xs text-white disabled:opacity-50"
          onClick={() =>
            void props.act(async () => {
              if (model)
                await window.eta.updateSettings({
                  defaultProvider: model.provider,
                  defaultModel: model.id,
                  defaultThinkingLevel: thinking,
                });
            })
          }
        >
          保存为新会话默认值
        </button>
        <button
          type="button"
          disabled={props.busy || !model || !props.threadId}
          className="rounded-lg border border-neutral-200 px-3 py-2 text-xs disabled:opacity-50"
          onClick={() =>
            void props.act(async () => {
              if (model && props.threadId) {
                await window.eta.configureThread(
                  props.threadId,
                  model.provider,
                  model.id,
                  thinking,
                );
                props.reconnect();
              }
            })
          }
        >
          应用到当前会话
        </button>
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        默认设置只影响新会话。当前会话运行或等待恢复时不能修改模型。
      </p>
      <h3 className="mt-8 mb-3 text-sm font-semibold">Provider 认证</h3>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void props.act(async () => {
            await window.eta.setApiKey(provider.trim(), apiKey);
            setApiKey("");
            props.reconnect();
          });
        }}
      >
        <label className="block text-xs">
          Provider ID
          <input
            className={`${fieldClass} mt-1`}
            autoComplete="off"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            placeholder="例如 anthropic、openai"
            required
          />
        </label>
        <label className="block text-xs">
          API key
          <input
            className={`${fieldClass} mt-1`}
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
          />
        </label>
        <button
          type="submit"
          disabled={props.busy}
          className="rounded-lg bg-neutral-900 px-3 py-2 text-xs text-white disabled:opacity-50"
        >
          保存认证
        </button>
      </form>
      <p className="mt-3 text-xs text-neutral-500">
        认证保存在 Eta 本机数据目录，文件仅当前用户可读写。已有 pi
        认证首次启动时会导入；环境变量也可继续使用。UI 不读取或显示密钥。
      </p>
      <ul className="mt-4 space-y-3 text-xs">
        {props.library.credentials.map((credential) => (
          <li key={credential.providerId} className="flex items-center justify-between">
            <span>
              {credential.providerId} · {credential.type}
            </span>
            <button
              type="button"
              disabled={props.busy}
              onClick={() =>
                void props.act(async () => {
                  await window.eta.removeCredential(credential.providerId);
                  props.reconnect();
                })
              }
              className="text-red-700"
            >
              移除认证
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
