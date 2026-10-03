import { useState } from "react";
import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { ThinkingLevel } from "../../../../src/agent/protocol.ts";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "./settings-section";
import { Select } from "@/components/ui/select";

interface Props {
  library: DesktopLibrary;
  threadId: string | null;
  busy: boolean;
  act: (action: () => Promise<void>) => Promise<void>;
  reconnect: () => void;
}
const thinkingOptions: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" },
];
export function ModelSettings(props: Props) {
  const [modelKey, setModelKey] = useState(
    `${props.library.settings.defaultProvider ?? props.library.models[0]?.provider ?? ""}/${props.library.settings.defaultModel ?? props.library.models[0]?.id ?? ""}`,
  );
  const [thinking, setThinking] = useState<ThinkingLevel>(
    props.library.settings.defaultThinkingLevel,
  );
  const model = props.library.models.find((model) => `${model.provider}/${model.id}` === modelKey);
  return (
    <SettingsSection title="模型与会话">
      <SettingsRow title="可用模型" description="选择 Agent 使用的模型">
        <Select
          size="compact"
          label="可用模型"
          value={modelKey}
          onValueChange={setModelKey}
          disabled={props.busy}
          placeholder="选择模型"
          options={props.library.models.map((model) => ({
            value: `${model.provider}/${model.id}`,
            label: `${model.provider} / ${model.name}`,
          }))}
        />
      </SettingsRow>
      <SettingsRow title="思考级别" description="模型思考时使用的推理级别">
        <Select
          size="compact"
          label="思考级别"
          value={thinking}
          onValueChange={setThinking}
          disabled={props.busy}
          options={thinkingOptions}
        />
      </SettingsRow>
      <SettingsRow
        title="应用设置"
        description="默认设置只影响新会话。当前会话运行或等待恢复时不能修改模型。"
      >
        <Button
          size="sm"
          disabled={props.busy || !model}
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
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy || !model || !props.threadId}
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
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
