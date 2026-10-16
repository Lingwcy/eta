import { localizedMessage } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  MessageCircle,
  Search,
  Settings2,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToastNotice } from "@/components/ui/toast";
import type { BrowserTab, DesktopTabs } from "@/agent/desktop-tabs";
import { useBrowserPage } from "@/browser/use-browser-page";
import type { BrowserClient, BrowserViewState } from "@/browser/client";

export function BrowserPanel({
  tab,
  state,
  client,
  visible,
  tabs,
}: {
  tab: BrowserTab;
  state?: BrowserViewState;
  client: BrowserClient;
  visible: boolean;
  tabs: DesktopTabs;
}) {
  useTranslation();
  const { address, setAddress, addressInput, viewport, ready, navigate, command, page, error } =
    useBrowserPage(tab, visible, client, state);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="flex h-[54px] shrink-0 items-center gap-2 border-b border-neutral-100 px-3">
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={t("browser:browserPanel.goBack")}
            disabled={!page?.canGoBack}
            onClick={() => command("back")}
          >
            <ArrowLeft size={17} />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={t("browser:browserPanel.goForward")}
            disabled={!page?.canGoForward}
            onClick={() => command("forward")}
          >
            <ArrowRight size={17} />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={
              page?.loading
                ? t("browser:browserPanel.stopLoading")
                : t("browser:browserPanel.reloadPage")
            }
            disabled={!ready}
            onClick={() => command(page?.loading ? "stop" : "reload")}
          >
            {page?.loading ? <X size={16} /> : <RotateCw size={16} />}
          </Button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void navigate();
          }}
          className="mx-auto flex h-9 min-w-0 max-w-[1100px] flex-1 items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-3.5 focus-within:border-neutral-400 focus-within:bg-white"
        >
          {tab.url ? (
            <Globe2 size={15} className="shrink-0 text-neutral-400" />
          ) : (
            <Search size={15} className="shrink-0 text-neutral-400" />
          )}
          <input
            ref={addressInput}
            id={`browser-address-${tab.id}`}
            aria-label={t("browser:browserPanel.urlOrSearchQuery")}
            placeholder={t("browser:browserPanel.searchOrEnterAUrl")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-700 outline-none"
          />
        </form>
      </div>
      <ToastNotice
        message={error}
        active={visible}
        title={localizedMessage("browser:browserPanel.thePageCouldNotBeLoaded")}
        onRetry={() => command("reload")}
      />
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden">
        {tab.url ? (
          <>
            {page?.preview && (
              <img src={page.preview} alt="" className="absolute inset-0 size-full object-fill" />
            )}
            {!ready && (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                {t("browser:browserPanel.openingPage")}
              </div>
            )}
          </>
        ) : (
          <div className="mx-auto flex h-full max-w-[620px] flex-col items-center justify-center px-8 pb-16">
            <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-neutral-100">
              <Globe2 size={28} strokeWidth={1.4} className="text-neutral-500" />
            </div>
            <h1 className="text-xl font-medium tracking-tight text-neutral-800">
              {t("browser:browserPanel.startHere")}
            </h1>
            <p className="mt-2 text-sm text-neutral-400">
              {t("browser:browserPanel.browseTheWebOrOpenANew")}
            </p>
            <div className="mt-8 flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => tabs.newConversation()}>
                <MessageCircle size={15} />
                {t("browser:browserPanel.newChat")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => tabs.openSettings()}>
                <Settings2 size={15} />
                {t("browser:browserPanel.settings")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
