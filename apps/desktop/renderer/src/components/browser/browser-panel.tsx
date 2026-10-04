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
  const { address, setAddress, addressInput, viewport, ready, navigate, command, page, error } =
    useBrowserPage(tab, visible, client, state);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white">
      <div className="flex h-[54px] shrink-0 items-center gap-2 border-b border-neutral-100 px-3">
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="网页后退"
            disabled={!page?.canGoBack}
            onClick={() => command("back")}
          >
            <ArrowLeft size={17} />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="网页前进"
            disabled={!page?.canGoForward}
            onClick={() => command("forward")}
          >
            <ArrowRight size={17} />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={page?.loading ? "停止加载" : "刷新网页"}
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
            aria-label="网址或搜索内容"
            placeholder="搜索，或输入网址"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.target.select()}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-700 outline-none"
          />
        </form>
      </div>
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50 px-5 py-3 text-sm text-neutral-500"
        >
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => command("reload")}>
            重试
          </Button>
        </div>
      )}
      <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden">
        {tab.url ? (
          <>
            {page?.preview && (
              <img src={page.preview} alt="" className="absolute inset-0 size-full object-fill" />
            )}
            {!ready && (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                正在打开网页…
              </div>
            )}
          </>
        ) : (
          <div className="mx-auto flex h-full max-w-[620px] flex-col items-center justify-center px-8 pb-16">
            <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-neutral-100">
              <Globe2 size={28} strokeWidth={1.4} className="text-neutral-500" />
            </div>
            <h1 className="text-xl font-medium tracking-tight text-neutral-800">从这里开始</h1>
            <p className="mt-2 text-sm text-neutral-400">浏览网页，或打开一个新的工作标签。</p>
            <div className="mt-8 flex items-center gap-3">
              <Button variant="secondary" size="sm" onClick={() => tabs.newConversation()}>
                <MessageCircle size={15} />
                新聊天
              </Button>
              <Button variant="ghost" size="sm" onClick={() => tabs.openSettings()}>
                <Settings2 size={15} />
                设置
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
