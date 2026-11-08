import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { themePreferences, type ThemePreference } from "../../../../src/appearance.ts";
import "./visual-mode.css";

const modeLabels = {
  system: "appearance.mode.system",
  light: "appearance.mode.light",
  dark: "appearance.mode.dark",
} as const;

function Preview({ mode }: { mode: "light" | "dark" }) {
  return (
    <span className={"visual-mode-preview visual-mode-preview--" + mode}>
      <svg viewBox="0 0 80 52" fill="none" aria-hidden="true">
        <rect x="9" y="8" width="62" height="36" rx="4" className="visual-mode-preview__surface" />
        <path d="M23 8v36" className="visual-mode-preview__divider" />
        <path
          d="M30 16h31M30 22h23M30 28h27"
          strokeWidth="2"
          strokeLinecap="round"
          className="visual-mode-preview__text"
        />
        <path d="M46 16h15M52 28h9" strokeWidth="2" strokeLinecap="round" stroke="#0866e6" />
        <rect
          x="29"
          y="34"
          width="34"
          height="5"
          rx="2.5"
          className="visual-mode-preview__divider"
        />
      </svg>
    </span>
  );
}

/** A feature-owned preview; no appearance-specific variants are added to shared controls. */
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
    <RadioGroup
      aria-label={t("appearance.visualMode")}
      value={value}
      disabled={disabled}
      onValueChange={onValueChange}
      className="visual-mode"
    >
      {themePreferences.map((mode) => (
        <Radio.Root
          key={mode}
          value={mode}
          aria-label={t(modeLabels[mode])}
          title={t(modeLabels[mode])}
          className="visual-mode-option"
        >
          <span
            aria-hidden="true"
            className={
              "visual-mode-thumbnail" + (mode === "system" ? " visual-mode-thumbnail--system" : "")
            }
          >
            {mode === "system" ? (
              <>
                <Preview mode="light" />
                <Preview mode="dark" />
              </>
            ) : (
              <Preview mode={mode} />
            )}
          </span>
          <Radio.Indicator className="visual-mode-check">
            <Check size={10} strokeWidth={3} />
          </Radio.Indicator>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}
