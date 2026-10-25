import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingsRow } from "./settings-section";
import type { ComputerPermission, ComputerStatus } from "../../../../src/shared/computer.ts";

/** The persisted switch grants local desktop access; OS grants remain independently visible. */
export function ComputerSettings({
  enabled,
  blockImages,
  busy,
  active,
  onChange,
}: {
  enabled: boolean;
  blockImages: boolean;
  busy: boolean;
  active: boolean;
  onChange: (enabled: boolean) => void;
}) {
  useTranslation();
  const [status, setStatus] = useState<ComputerStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!active) return;
    let current = true;
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void window.eta.computerStatus().then(
        (value) => {
          if (current && request === revision) {
            setStatus(value);
            setError(undefined);
          }
        },
        () => {
          if (current && request === revision)
            setError(t("settings:permissionSettings.computerStatusFailed"));
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [active]);
  const permission = async (value: ComputerPermission) => {
    try {
      await window.eta.openComputerPermissions(value);
    } catch {
      setError(t("settings:permissionSettings.computerPermissionsFailed"));
    }
  };
  const unsupported = status?.status === "unsupported" || status?.status === "unavailable";
  return (
    <SettingsSection title="Computer use">
      <SettingsRow
        title={t("settings:permissionSettings.computerUse")}
        description={
          status?.status === "unsupported"
            ? t("settings:permissionSettings.computerMacOnly")
            : status?.status === "unavailable"
              ? status.message
              : t("settings:permissionSettings.computerDescription")
        }
      >
        <Button
          variant="outline"
          size="sm"
          aria-label={t("settings:permissionSettings.computerUse")}
          aria-pressed={enabled}
          disabled={busy || (!enabled && (!status || unsupported))}
          onClick={() => onChange(!enabled)}
        >
          {t(enabled ? "settings:permissionSettings.on" : "settings:permissionSettings.off")}
        </Button>
      </SettingsRow>
      {enabled && status && (status.status === "ready" || status.status === "permissions") && (
        <>
          <SettingsRow
            title={t("settings:permissionSettings.screenRecording")}
            description={t(
              status.screen
                ? "settings:permissionSettings.permissionGranted"
                : "settings:permissionSettings.permissionRequired",
            )}
          >
            {!status.screen && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void permission("screen")}
              >
                {t("settings:permissionSettings.openSystemSettings")}
              </Button>
            )}
          </SettingsRow>
          <SettingsRow
            title={t("settings:permissionSettings.accessibility")}
            description={t(
              status.accessibility
                ? "settings:permissionSettings.permissionGranted"
                : "settings:permissionSettings.permissionRequired",
            )}
          >
            {!status.accessibility && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void permission("accessibility")}
              >
                {t("settings:permissionSettings.openSystemSettings")}
              </Button>
            )}
          </SettingsRow>
        </>
      )}
      {enabled && blockImages && (
        <SettingsRow
          title={t("settings:permissionSettings.computerImagesBlocked")}
          description={t("settings:permissionSettings.computerEnableImages")}
        >
          {null}
        </SettingsRow>
      )}
      {error && <SettingsRow title={error}>{null}</SettingsRow>}
    </SettingsSection>
  );
}
