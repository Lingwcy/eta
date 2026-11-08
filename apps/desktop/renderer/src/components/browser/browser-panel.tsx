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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-soft px-2.5">
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
          className="mx-auto flex h-8 min-w-0 max-w-[1100px] flex-1 items-center gap-2 rounded-full border border-border bg-surface-soft px-3 focus-within:border-border-control focus-within:bg-surface"
        >
          {tab.url ? (
            <Globe2 size={15} className="shrink-0 text-muted" />
          ) : (
            <Search size={15} className="shrink-0 text-muted" />
          )}
          <input
            ref={addressInput}
            id={`browser-address-${tab.id}`}
            aria-label={t("browser:browserPanel.urlOrSearchQuery")}
            placeholder={t("browser:browserPanel.searchOrEnterAUrl")}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-strong outline-none"
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
              <div className="flex h-full items-center justify-center text-sm text-muted">
                {t("browser:browserPanel.openingPage")}
              </div>
            )}
          </>
        ) : (
          <div className="mx-auto flex h-full max-w-[560px] flex-col items-center justify-center px-8 pb-14">
            <div className="mb-4 flex size-11 items-center justify-center rounded-xl bg-surface-subtle">
              <Globe2 size={22} strokeWidth={1.5} className="text-subtle" />
            </div>
            <h1 className="text-[17px] font-semibold tracking-tight text-heading">
              {t("browser:browserPanel.startHere")}
            </h1>
            <p className="mt-1 text-[13px] text-muted">
              {t("browser:browserPanel.browseTheWebOrOpenANew")}
            </p>
            <div className="mt-6 flex items-center gap-2">
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
