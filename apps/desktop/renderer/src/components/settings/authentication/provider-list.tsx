import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Check, LogOut } from "lucide-react";
import type { AuthProvider, LoginMethod } from "../../../../../src/authentication.ts";
import type { DesktopLibrary } from "../../../../../src/bridge.ts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ProviderLogo } from "./provider-logo";
import { SubscriptionQuota } from "./subscription-quota";

export function ProviderList({
  providers,
  library,
  method,
  busy,
  onLogin,
  onRemove,
}: {
  providers: readonly AuthProvider[];
  library: DesktopLibrary;
  method: LoginMethod;
  busy: boolean;
  onLogin: (provider: string) => void;
  onRemove: (provider: string) => void;
}) {
  useTranslation();
  if (!providers.length)
    return (
      <p className="py-8 text-center text-xs text-muted">
        {t("settings:providerList.noMatchingProviders")}
      </p>
    );
  return (
    <Card>
      {providers.map((provider) => {
        const credential = library.credentials.find((entry) => entry.providerId === provider.id);
        const connected = credential?.type === method;
        const count = library.models.filter((model) => model.provider === provider.id).length;
        const ambient = method === "api_key" && !credential && count > 0;
        const quotaConnection =
          method === "oauth" && connected
            ? library.quotaConnections?.find((entry) => entry.providerId === provider.id)
            : undefined;
        return (
          <div
            key={provider.id}
            className="flex flex-wrap items-center gap-x-6 gap-y-2.5 py-2.5 min-[901px]:flex-nowrap"
          >
            <ProviderLogo id={provider.id} name={provider.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="min-w-0 text-[13px] font-medium break-words text-heading">
                  {provider.name}
                </h3>
                {connected && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success-tint-50 px-1.5 py-px text-[10px] font-medium text-success-text-700">
                    <Check size={10} />
                    {t("settings:providerList.connected")}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs/4 break-words text-subtle">
                {connected
                  ? t("settings:providerList.availableModels", { count: count })
                  : credential
                    ? t("settings:providerList.currentlyConnectedViaSuccessfulSignInWill", {
                        value1:
                          credential.type === "oauth"
                            ? t("settings:providerList.account")
                            : "API Key",
                      })
                    : ambient
                      ? t("settings:providerList.environmentConfigurationAvailableModels", {
                          count: count,
                        })
                      : method === "oauth"
                        ? provider.accountLabel
                        : t("settings:providerList.connectWithYourOwnApiKey")}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {quotaConnection && (
                <SubscriptionQuota
                  key={quotaConnection.connectionId}
                  providerId={provider.id}
                  connectionId={quotaConnection.connectionId}
                />
              )}
              {connected && (
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label={t("settings:providerList.disconnect", { name: provider.name })}
                  title={t("settings:providerList.disconnect2")}
                  onClick={() => onRemove(provider.id)}
                  disabled={busy}
                >
                  <LogOut size={15} />
                </Button>
              )}
              <Button
                variant={connected ? "outline" : "secondary"}
                size="sm"
                disabled={busy}
                onClick={() => onLogin(provider.id)}
              >
                {connected
                  ? method === "oauth"
                    ? t("settings:providerList.signInAgain")
                    : t("settings:providerList.updateConfiguration")
                  : t("settings:providerList.connect")}
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
