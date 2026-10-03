import { useState } from "react";
import type { AgentModel, ThinkingLevel } from "../../../../../src/agent/protocol.ts";
import type { DesktopSettings } from "../../../../../src/main/service/settings/index.ts";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "../settings-section";

const thinkingOptions = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
] satisfies { value: ThinkingLevel; label: string }[];

export function ModelPreferences({
  models,
  settings,
  threadId,
  busy,
  act,
  reconnect,
}: {
  models: readonly AgentModel[];
  settings: DesktopSettings;
  threadId: string | null;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
}) {
  const defaultModel =
    models.find(
      (model) => model.provider === settings.defaultProvider && model.id === settings.defaultModel,
    ) ?? models[0];
  const [selected, setSelected] = useState<string | null>(null);
  const [thinking, setThinking] = useState<ThinkingLevel>(settings.defaultThinkingLevel);
  const model =
    models.find((entry) => `${entry.provider}/${entry.id}` === selected) ?? defaultModel;
  const modelKey = model ? `${model.provider}/${model.id}` : "";
  if (!models.length) return null;
  return (
    <div className="mt-8">
      <SettingsSection title="模型偏好">
        <SettingsRow title="模型" description="从已连接服务中选择模型">
          <Select
            label="模型"
            value={modelKey}
            onValueChange={setSelected}
            disabled={busy}
            options={models.map((model) => ({
              value: `${model.provider}/${model.id}`,
              label: `${model.provider} / ${model.name}`,
            }))}
          />
        </SettingsRow>
        <SettingsRow title="思考级别">
          <Select
            label="思考级别"
            value={thinking}
            onValueChange={setThinking}
            options={thinkingOptions}
            disabled={busy}
          />
        </SettingsRow>
        <SettingsRow title="应用偏好" description="默认值用于新会话；正在运行的会话会保留原模型。">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !model || !threadId}
            onClick={() =>
              void act(async () => {
                if (!model || !threadId) return;
                await window.eta.configureThread(threadId, model.provider, model.id, thinking);
                reconnect();
              })
            }
          >
            应用到当前会话
          </Button>
          <Button
            size="sm"
            disabled={busy || !model}
            onClick={() =>
              void act(async () => {
                if (model)
                  await window.eta.updateSettings({
                    defaultProvider: model.provider,
                    defaultModel: model.id,
                    defaultThinkingLevel: thinking,
                  });
              })
            }
          >
            设为默认
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
