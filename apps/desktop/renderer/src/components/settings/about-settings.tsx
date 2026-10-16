import { describeError, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import type { AppInfo, UpdateState } from "../../../../src/bridge.ts";
import { useUpdateState } from "@/agent/use-update-state";
import { ToastNotice } from "@/components/ui/toast";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "./settings-section";

function describe(state: UpdateState | undefined) {
  switch (state?.status) {
    case undefined:
    case "idle":
      return t("settings:aboutSettings.updatesHaveNotBeenCheckedYet");
    case "unsupported":
      return t("settings:aboutSettings.unavailableInDevelopmentMode");
    case "checking":
      return t("settings:aboutSettings.checkingForUpdates");
    case "not-available":
      return t("settings:aboutSettings.youAreUpToDate");
    case "available":
      return t("settings:aboutSettings.newVersionVFoundPreparingDownload", {
        version: state.version,
      });
    case "downloading":
      return t("settings:aboutSettings.downloadingV", {
        version: state.version,
        percent: state.percent,
      });
    case "downloaded":
      return t("settings:aboutSettings.vDownloadedRestartToInstall", { version: state.version });
    case "error":
      return t("settings:aboutSettings.updateFailed");
  }
}

export function AboutSettings({
  autoCheck,
  backgroundOnClose,
  onBackgroundChange,
  busy,
  onAutoCheckChange,
}: {
  autoCheck: boolean;
  backgroundOnClose: boolean;
  onBackgroundChange(this: void, enabled: boolean): void;
  busy: boolean;
  onAutoCheckChange: (enabled: boolean) => void;
}) {
  useTranslation();
  const [info, setInfo] = useState<AppInfo>();
  const [update, setUpdate] = useUpdateState();
  const [error, setError] = useState<Message>();
  useEffect(() => {
    void window.eta.appInfo().then(setInfo, (error: unknown) => setError(String(error)));
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(describeError(error, String(error)));
    }
  };
  const status = update?.status;
  const unsupported = status === "unsupported";
  const working = status === "checking" || status === "available" || status === "downloading";
  return (
    <>
      <ToastNotice message={error} />
      <SettingsSection title="Eta">
        <SettingsRow
          title={
            info
              ? t("settings:aboutSettings.versionV", { version: info.version })
              : t("settings:aboutSettings.version")
          }
        >
          <Avatar label="Eta" fallback="η" src="./favicon.svg" variant="brand" />
        </SettingsRow>
      </SettingsSection>
      {info?.platform === "win32" && (
        <SettingsSection title={t("settings:aboutSettings.runInBackground")}>
          <SettingsRow
            title={t("settings:aboutSettings.keepRunningAfterClosingTheWindow")}
            description={t("settings:aboutSettings.keepTheTrayIconAndScheduledTasks")}
          >
            <Button
              size="sm"
              variant={backgroundOnClose ? "secondary" : "outline"}
              disabled={busy}
              aria-pressed={backgroundOnClose}
              onClick={() => onBackgroundChange(!backgroundOnClose)}
            >
              {backgroundOnClose
                ? t("settings:aboutSettings.enabled")
                : t("settings:aboutSettings.disabled")}
            </Button>
          </SettingsRow>
        </SettingsSection>
      )}
      <SettingsSection title={t("settings:aboutSettings.updates")}>
        <SettingsRow
          title={t("settings:aboutSettings.softwareUpdates")}
          description={describe(update)}
        >
          {status === "downloaded" ? (
            <Button size="sm" onClick={() => void run(() => window.eta.installUpdate())}>
              {t("settings:aboutSettings.restartAndInstall")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={unsupported || working}
              onClick={() => void run(() => window.eta.checkForUpdates().then(setUpdate))}
            >
              {t("settings:aboutSettings.checkForUpdates")}
            </Button>
          )}
        </SettingsRow>
        {update?.status === "error" && (
          <SettingsRow
            title={t("settings:aboutSettings.cannotUpdateAutomatically")}
            description={update.message}
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(() => window.eta.openReleasePage())}
            >
              {t("settings:aboutSettings.goToDownloads")}
            </Button>
          </SettingsRow>
        )}
        <SettingsRow title={t("settings:aboutSettings.checkForUpdatesAutomatically")}>
          <Button
            size="sm"
            variant={autoCheck ? "secondary" : "outline"}
            disabled={busy || unsupported}
            aria-pressed={autoCheck}
            onClick={() => onAutoCheckChange(!autoCheck)}
          >
            {autoCheck ? t("settings:aboutSettings.enabled") : t("settings:aboutSettings.disabled")}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
