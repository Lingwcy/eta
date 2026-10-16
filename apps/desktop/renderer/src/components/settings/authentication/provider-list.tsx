import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Check, LogOut } from "lucide-react";
import type { AuthProvider, LoginMethod } from "../../../../../src/authentication.ts";
import type { DesktopLibrary } from "../../../../../src/bridge.ts";
import { Button } from "@/components/ui/button";
import { ProviderLogo } from "./provider-logo";

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
      <p className="py-10 text-center text-sm text-neutral-400">
        {t("settings:providerList.noMatchingProviders")}
      </p>
    );
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white divide-y divide-neutral-100">
      {providers.map((provider) => {
        const credential = library.credentials.find((entry) => entry.providerId === provider.id);
        const connected = credential?.type === method;
        const count = library.models.filter((model) => model.provider === provider.id).length;
        const ambient = method === "api_key" && !credential && count > 0;
        return (
          <div
            key={provider.id}
            className="flex flex-wrap items-center gap-3 px-4 py-4 min-[901px]:gap-4 min-[901px]:px-5"
          >
            <ProviderLogo id={provider.id} name={provider.name} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm font-medium text-neutral-900">{provider.name}</h3>
                {connected && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    <Check size={10} />
                    {t("settings:providerList.connected")}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs/5 text-neutral-500">
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
            <div className="flex items-center gap-1.5">
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
    </div>
  );
}
