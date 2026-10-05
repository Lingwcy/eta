import { ThreadContextMenu } from "../threads/thread-actions";
import { lazy, Suspense, useEffect, useId, useState } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { ArrowLeft, ArrowRight, ChevronDown, PanelLeft, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DesktopTabState, DesktopTabs } from "@/agent/desktop-tabs";
import type { TabPresentation } from "@/agent/tab-presentations";
import { TabIcon } from "./tab-icon";

const TabListMenu = lazy(() =>
  import("./tab-list-menu").then((module) => ({ default: module.TabListMenu })),
);

export function DesktopTabBar({
  state,
  tabs,
  items,
  collapsed,
  onToggle,
  onOverlay,
  onPreview,
}: {
  state: DesktopTabState;
  tabs: DesktopTabs;
  items: readonly TabPresentation[];
  collapsed: boolean;
  onToggle: () => void;
  onOverlay: (open: boolean) => void;
  onPreview: (id: string) => void;
}) {
  const [handle] = useState(() => PreviewCard.createHandle<TabPresentation>());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const menuTriggerId = useId();
  const browsing = tabs.activeTab.kind === "browser";
  const single = state.tabs.length === 1;
  const sidebar = !browsing && (tabs.activeTab.kind === "settings" || !collapsed);
  const mac = navigator.userAgent.includes("Mac");
  useEffect(() => {
    onOverlay(previewOpen || listOpen);
  }, [previewOpen, listOpen, onOverlay]);
  useEffect(() => {
    setPreviewOpen(false);
    setListOpen(false);
    document
      .getElementById(`tab-${state.activeId}`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId]);
  const select = (id: string) => {
    setPreviewOpen(false);
    setListOpen(false);
    tabs.select(id);
  };
  return (
    <header
      className={cn(
        "relative flex h-[42px] shrink-0 items-center border-b border-neutral-200/60 bg-[#f3f3f3] pr-2 [-webkit-app-region:drag]",
        browsing && (mac ? "pl-[98px]" : "pl-2"),
      )}
    >
      {!browsing && (
        <div
          className={cn(
            "relative flex h-full shrink-0 items-center pr-2 transition-[width] duration-180 ease-out motion-reduce:transition-none after:absolute after:top-3 after:right-0 after:bottom-3 after:border-r after:border-neutral-200 after:opacity-0 after:transition-opacity after:duration-0 motion-reduce:after:delay-0",
            mac ? "pl-[98px]" : "pl-2",
            sidebar
              ? "w-[calc(var(--rail-width)+var(--sidebar-width))] after:opacity-100 after:delay-180"
              : mac
                ? "w-[194px]"
                : "w-[104px]",
          )}
        >
          <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="返回上一个标签"
              title="后退"
              disabled={state.historyIndex === 0}
              onClick={() => tabs.navigate(-1)}
            >
              <ArrowLeft size={17} />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="前进到下一个标签"
              title="前进"
              disabled={state.historyIndex >= state.history.length - 1}
              onClick={() => tabs.navigate(1)}
            >
              <ArrowRight size={17} />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label={collapsed ? "显示侧栏" : "隐藏侧栏"}
              title="切换侧栏 (⌘B)"
              aria-expanded={!collapsed}
              onClick={onToggle}
            >
              <PanelLeft size={17} />
            </Button>
          </div>
        </div>
      )}
      {single ? (
        <div className="flex min-w-0 flex-1 select-none items-center gap-2 pl-3 text-[13px] font-medium text-neutral-800">
          <TabIcon item={items[0]!} />
          <ThreadContextMenu
            id={state.tabs[0]?.kind === "conversation" ? state.tabs[0].threadId : undefined}
          >
            <span id={`tab-${state.activeId}`} className="truncate [-webkit-app-region:no-drag]">
              {items[0]!.title}
            </span>
          </ThreadContextMenu>
        </div>
      ) : (
        <div
          role="tablist"
          aria-label="打开的标签"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 pl-1 [scrollbar-width:none] [-webkit-app-region:drag]"
          onKeyDown={(event) => {
            const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % state.tabs.length
                : event.key === "ArrowLeft"
                  ? (index + state.tabs.length - 1) % state.tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? state.tabs.length - 1
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              select(state.tabs[next]!.id);
              document.getElementById(`tab-${state.tabs[next]!.id}`)?.focus();
            } else if (event.key === "Delete") {
              event.preventDefault();
              tabs.close(state.activeId);
            }
          }}
        >
          {items.map((item) => {
            const active = item.id === state.activeId;
            const tab = state.tabs.find((tab) => tab.id === item.id);
            return (
              <ThreadContextMenu
                key={item.id}
                id={tab?.kind === "conversation" ? tab.threadId : undefined}
              >
                <div
                  className={cn(
                    "group/tab relative flex h-8 min-w-[120px] max-w-[280px] flex-[1_0_180px] items-center rounded-lg transition-colors [-webkit-app-region:no-drag]",
                    active
                      ? "bg-white text-neutral-800 shadow-[0_1px_3px_#00000008]"
                      : "text-neutral-500 hover:bg-neutral-200/60",
                    !active &&
                      "after:absolute after:right-0 after:top-2 after:h-4 after:w-px after:bg-neutral-300/70 after:content-[''] hover:after:opacity-0",
                  )}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-eta-tab", item.id);
                    event.dataTransfer.effectAllowed = "move";
                    setPreviewOpen(false);
                  }}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes("application/x-eta-tab")) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    tabs.move(event.dataTransfer.getData("application/x-eta-tab"), item.id);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      tabs.close(item.id);
                    }
                  }}
                >
                  <PreviewCard.Trigger
                    id={`tab-${item.id}`}
                    handle={handle}
                    payload={item}
                    delay={500}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-controls={`panel-${item.id}`}
                        tabIndex={active ? 0 : -1}
                        onClick={() => select(item.id)}
                        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg pr-8 pl-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-400"
                      />
                    }
                  >
                    <TabIcon item={item} />
                    <span className={cn("truncate", active && "font-medium")}>{item.title}</span>
                  </PreviewCard.Trigger>
                  <div
                    className={cn(
                      "absolute right-1.5 [-webkit-app-region:no-drag]",
                      !active &&
                        "opacity-0 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`关闭 ${item.title}`}
                      title="关闭标签 (⌘W)"
                      tabIndex={-1}
                      onClick={() => {
                        setPreviewOpen(false);
                        tabs.close(item.id);
                      }}
                      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-300/50 hover:text-neutral-700"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </ThreadContextMenu>
            );
          })}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1 pl-1 [-webkit-app-region:no-drag]">
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="新建网页标签"
          title="新标签页 (⌘T)"
          onClick={() => tabs.newBrowser()}
        >
          <Plus size={20} />
        </Button>
        <Suspense
          fallback={
            <Button
              id={menuTriggerId}
              variant="ghost-muted"
              size="icon-xs"
              aria-label="标签列表"
              title="标签列表"
              aria-expanded={listOpen}
              onClick={() => {
                setPreviewOpen(false);
                setListOpen(true);
              }}
            >
              <ChevronDown size={17} />
            </Button>
          }
        >
          <TabListMenu
            triggerId={menuTriggerId}
            tabs={tabs}
            items={items}
            open={listOpen}
            onSelect={select}
            onOpenChange={(open) => {
              setPreviewOpen(false);
              setListOpen(open);
            }}
          />
        </Suspense>
      </div>
      <PreviewCard.Root
        handle={handle}
        open={previewOpen}
        onOpenChange={(open, details) => {
          setPreviewOpen(open && !listOpen);
          if (open && !listOpen && details.trigger) onPreview(details.trigger.id.slice(4));
        }}
      >
        {({ payload: selected }) => {
          const payload = items.find((item) => item.id === selected?.id);
          return (
            payload && (
              <PreviewCard.Portal>
                <PreviewCard.Positioner side="bottom" align="start" sideOffset={4} className="z-50">
                  <PreviewCard.Popup className="w-64 max-w-[calc(100vw-32px)] overflow-hidden rounded-[10px] border border-black/12 bg-[#f8f8f8]/95 p-2 text-xs text-neutral-800 shadow-[0_6px_20px_#00000018,0_0_0_1px_#00000004] outline-none backdrop-blur-xl [-webkit-app-region:no-drag]">
                    <p className="truncate font-medium">{payload.title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-neutral-400">
                      {payload.running ? "正在执行 · " : ""}
                      {payload.subtitle}
                    </p>
                    {payload.preview ? (
                      <img
                        src={payload.preview}
                        alt={`${payload.title} 的页面预览`}
                        className="mt-2 aspect-video w-full rounded-[5px] object-cover object-top"
                      />
                    ) : (
                      <div className="mt-2 rounded-[5px] bg-black/4 px-2 py-1.5 leading-5">
                        <p className="line-clamp-3 whitespace-pre-wrap">{payload.text}</p>
                      </div>
                    )}
                  </PreviewCard.Popup>
                </PreviewCard.Positioner>
              </PreviewCard.Portal>
            )
          );
        }}
      </PreviewCard.Root>
    </header>
  );
}
