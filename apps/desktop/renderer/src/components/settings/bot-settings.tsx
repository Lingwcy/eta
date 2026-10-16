import { renderMessage } from "@/i18n/messages";
import { describeError, localizedMessage, type Message } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { useState } from "react";
import type { BotState } from "../../../../src/shared/bot.ts";
import { SettingsRow, SettingsSection } from "./settings-section";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToastNotice } from "@/components/ui/toast";

export function BotSettings({ bot, refresh }: { bot?: BotState; refresh: () => Promise<void> }) {
  useTranslation();
  const [url, setUrl] = useState(bot?.url ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Message>();
  const [error, setError] = useState<Message>();
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      await action();
      setToken("");
      await refresh();
    } catch (error) {
      setError(describeError(error, localizedMessage("settings:botSettings.botConnectionFailed")));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ToastNotice
        message={error}
        title={localizedMessage("settings:botSettings.theBotActionCouldNotBeCompleted")}
      />
      <ToastNotice
        message={result}
        type="success"
        title={localizedMessage("settings:botSettings.botConfigurationUpdated")}
      />
      <SettingsSection title={t("settings:botSettings.botConnection")}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => window.eta.connectBot({ url: url.trim(), token: token.trim() }));
          }}
        >
          <SettingsRow
            title={t("settings:botSettings.serverAddress")}
            description={t("settings:botSettings.enterYourDeployedEtaBotAddressOnce")}
          >
            <div className="w-64">
              <Input
                aria-label={t("settings:botSettings.botServerAddress")}
                placeholder="https://bot.example.com"
                value={url}
                onValueChange={setUrl}
                disabled={busy}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={t("settings:botSettings.accessToken")}
            description={t("settings:botSettings.useTheAdministratorTokenConfiguredWhenDeploying")}
          >
            <div className="w-64">
              <Input
                type="password"
                autoComplete="off"
                aria-label={t("settings:botSettings.botAccessToken")}
                placeholder={
                  bot?.url
                    ? t("settings:botSettings.enterATokenToChangeTheConnection")
                    : t("settings:botSettings.administratorToken")
                }
                value={token}
                onValueChange={setToken}
                disabled={busy}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={t("settings:botSettings.connectionStatus")}
            description={
              bot?.status === "connected"
                ? t("settings:botSettings.connectedCloudProjects", {
                    count: bot.library?.projects.length ?? 0,
                  })
                : (renderMessage(bot?.localization ?? bot?.message) ??
                  t("settings:botSettings.disconnected"))
            }
          >
            {bot?.url && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => window.eta.reconnectBot())}
                >
                  {t("settings:botSettings.reconnect")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void act(() => window.eta.disconnectBot())}
                >
                  {t("settings:botSettings.disconnect")}
                </Button>
              </>
            )}
            <Button size="sm" type="submit" disabled={busy || !url.trim() || !token.trim()}>
              {busy
                ? t("settings:botSettings.processing")
                : t("settings:botSettings.saveAndConnect")}
            </Button>
          </SettingsRow>
        </form>
      </SettingsSection>
      <SettingsSection title={t("settings:botSettings.botConfiguration")}>
        <SettingsRow
          title={t("settings:botSettings.modelCredentials")}
          description={t("settings:botSettings.copyApiKeysAndOauthCredentialsSaved")}
        >
          <Button
            size="sm"
            disabled={busy || bot?.status !== "connected"}
            onClick={() =>
              void act(async () => {
                const value = await window.eta.importBotCredentials();
                setResult(
                  localizedMessage("settings:botSettings.importedCredentialsForProviders", {
                    count: value.imported,
                  }),
                );
              })
            }
          >
            {busy
              ? t("settings:botSettings.processing")
              : t("settings:botSettings.importClientCredentials")}
          </Button>
        </SettingsRow>
        {bot?.library?.credentials?.map((credential) => (
          <SettingsRow
            key={credential.providerId}
            title={credential.providerId}
            description={credential.type === "oauth" ? "OAuth" : "API Key"}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || bot?.status !== "connected"}
              onClick={() => void act(() => window.eta.removeBotCredential(credential.providerId))}
            >
              {t("settings:botSettings.remove")}
            </Button>
          </SettingsRow>
        ))}
      </SettingsSection>
    </>
  );
}
