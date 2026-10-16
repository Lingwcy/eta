import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { AgentThinking } from "@/components/agent-thinking";
import type { AgentThinkingVariant } from "../../../../src/appearance.ts";
import { Select } from "@/components/ui/select";
import { SettingsRow, SettingsSection } from "./settings-section";
import { locales, defaultLocale, type AppLocale } from "../../../../src/shared/i18n/locales.ts";

const variants = () =>
  [
    { value: "wave", label: t("settings:appearanceSettings.dotWave") },
    { value: "spin", label: t("settings:appearanceSettings.dotSpin") },
    { value: "stars", label: t("settings:appearanceSettings.twinklingStars") },
    { value: "infinity", label: t("settings:appearanceSettings.infinityLoop") },
  ] satisfies { value: AgentThinkingVariant; label: string }[];

export function AppearanceSettings({
  variant,
  active,
  busy,
  onVariantChange,
  locale = defaultLocale,
  onLocaleChange,
}: {
  variant: AgentThinkingVariant;
  active: boolean;
  busy: boolean;
  onVariantChange: (variant: AgentThinkingVariant) => void;
  locale?: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  useTranslation();
  return (
    <>
      <SettingsSection title={t("settings:appearance.languageSection")}>
        <SettingsRow title="语言 / Language">
          <Select
            value={locale}
            options={locales}
            label="语言 / Language"
            panelTitle="语言 / Language"
            size="compact"
            variant="menu"
            disabled={busy}
            onValueChange={onLocaleChange}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("settings:appearanceSettings.thinkingAndResponses")}>
        <SettingsRow
          title={t("settings:appearanceSettings.animationStyle")}
          description={t("settings:appearanceSettings.usedWhileThinkingAndWaitingForResponses")}
        >
          <Select
            value={variant}
            options={variants()}
            label={t("settings:appearanceSettings.thinkingAnimationStyle")}
            panelTitle={t("settings:appearanceSettings.animationStyle")}
            size="compact"
            variant="menu"
            disabled={busy}
            onValueChange={onVariantChange}
          />
        </SettingsRow>
        <div
          className="flex items-center gap-5 py-3"
          aria-label={t("settings:appearanceSettings.animationPreview")}
        >
          <span className="text-xs text-neutral-400">
            {t("settings:appearanceSettings.preview")}
          </span>
          <AgentThinking
            key={variant}
            variant={variant}
            label={t("settings:appearanceSettings.thinking")}
            active={active}
          />
        </div>
      </SettingsSection>
    </>
  );
}
