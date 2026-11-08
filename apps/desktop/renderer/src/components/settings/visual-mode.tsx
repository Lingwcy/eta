import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { themePreferences, type ThemePreference } from "../../../../src/appearance.ts";

const modes = {
  system: { label: "appearance.mode.system", icon: Monitor },
  light: { label: "appearance.mode.light", icon: Sun },
  dark: { label: "appearance.mode.dark", icon: Moon },
} as const;

export function VisualMode({
  value,
  disabled,
  onValueChange,
}: {
  value: ThemePreference;
  disabled: boolean;
  onValueChange: (value: ThemePreference) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SegmentedControl
      aria-label={t("appearance.visualMode")}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
      options={themePreferences.map((mode) => {
        const { label, icon: Icon } = modes[mode];
        return {
          value: mode,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Icon size={14} aria-hidden="true" />
              {t(label)}
            </span>
          ),
        };
      })}
    />
  );
}
