import type { DesktopLibrary } from "../../../../src/bridge.ts";
import type { DesktopSettings } from "../../../../src/shared/settings.ts";
import { ModelPicker } from "../input/model-picker";
import { SettingsSection, SettingsRow } from "./settings-section";

export function ConversationSettings({
  library,
  busy,
  onTitleModelChange,
}: {
  library: DesktopLibrary;
  busy: boolean;
  onTitleModelChange: (model: DesktopSettings["titleModel"]) => void;
}) {
  const selected = library.settings.titleModel;
  const model = library.models.find(
    (model) => model.provider === selected?.provider && model.id === selected.modelId,
  );
  return (
    <SettingsSection title="会话标题">
      <SettingsRow
        title="标题生成模型"
        description="首次发送后自动生成标题。默认使用该对话的模型，也可指定其他模型；手动修改的标题会保留。"
      >
        <div className="max-w-64">
          <ModelPicker
            model={model}
            models={library.models}
            providers={library.providers}
            showThinking={false}
            side="bottom"
            placeholder={
              selected ? `${selected.provider}/${selected.modelId}（不可用）` : undefined
            }
            defaultOption={{
              label: "跟随对话模型",
              selected: !selected,
              onSelect: () => onTitleModelChange(null),
            }}
            disabled={busy}
            onChange={(model) =>
              onTitleModelChange({ provider: model.provider, modelId: model.id })
            }
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
