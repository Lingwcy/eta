import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
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
  useTranslation();
  const selected = library.settings.titleModel;
  const model = library.models.find(
    (model) => model.provider === selected?.provider && model.id === selected.modelId,
  );
  return (
    <SettingsSection title={t("settings:conversationSettings.chatTitles")}>
      <SettingsRow
        title={t("settings:conversationSettings.titleGenerationModel")}
        description={t("settings:conversationSettings.generateATitleAfterTheFirstMessage")}
      >
        <div className="max-w-64">
          <ModelPicker
            model={model}
            models={library.models}
            providers={library.providers}
            showThinking={false}
            side="bottom"
            placeholder={
              selected
                ? t("settings:conversationSettings.unavailable", {
                    provider: selected.provider,
                    modelId: selected.modelId,
                  })
                : undefined
            }
            defaultOption={{
              label: t("settings:conversationSettings.useTheChatModel"),
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
