import { lazy, Suspense } from "react";
import type { DesktopShell } from "@/agent/use-desktop-shell";
import { DesktopLayout } from "@/components/desktop-layout";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { BrowserPanel } from "@/components/browser/browser-panel";
import { ConversationPanel } from "./conversation-panel";
import { cn } from "@/lib/utils";

const DesktopSettings = lazy(() =>
  import("@/components/desktop-settings").then((module) => ({ default: module.DesktopSettings })),
);

/** Keep inactive pages mounted so each composer and web page retains its own state. */
export function DesktopPanels({ shell }: { shell: DesktopShell }) {
  const { navigation, browser, overlay } = shell;
  const { state, tabs } = navigation;
  return (
    <>
      <ConversationWorkspace shell={shell} />
      {state.tabs
        .filter((tab) => tab.kind !== "conversation")
        .map((tab) => {
          const active = tab.id === state.activeId;
          return (
            <section
              key={tab.id}
              id={`panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`tab-${tab.id}`}
              className={cn(
                "min-h-0 flex-1 flex-col",
                active ? "flex" : "hidden",
                tab.kind === "browser" && "mx-[7px] mb-[7px] overflow-hidden rounded-xl bg-white",
              )}
            >
              {tab.kind === "browser" ? (
                <BrowserPanel
                  tab={tab}
                  state={browser.pages[tab.id]}
                  client={browser.client}
                  visible={active && !overlay}
                  tabs={tabs}
                />
              ) : (
                <Suspense fallback={<SettingsLoading />}>
                  {shell.desktop.library ? (
                    <DesktopSettings
                      active={active}
                      library={shell.desktop.library}
                      onChooseProject={shell.chooseProject}
                      busy={shell.desktop.busy}
                      act={shell.desktop.act}
                      error={shell.desktop.error}
                      reconnect={shell.reconnect}
                      refresh={shell.refreshSettings}
                      onClose={() => tabs.close(tab.id)}
                    />
                  ) : (
                    <SettingsLoading error={shell.desktop.error} />
                  )}
                </Suspense>
              )}
            </section>
          );
        })}
    </>
  );
}

function ConversationWorkspace({ shell }: { shell: DesktopShell }) {
  const { desktop, navigation, collapsed, version, savePreview } = shell;
  const { tabs, state, runningThreadIds } = navigation;
  const active = tabs.activeTab;
  const conversation = active.kind === "conversation" ? active : undefined;
  return (
    <div className={cn("min-h-0 flex-1", conversation ? "flex" : "hidden")}>
      <DesktopLayout
        collapsed={collapsed}
        sidebar={
          <DesktopSidebar
            library={desktop.library}
            runningThreadIds={runningThreadIds}
            workspaceId={conversation?.workspaceId ?? null}
            threadId={conversation?.threadId ?? null}
            busy={desktop.busy}
            collapsed={collapsed}
            onExpand={shell.expandSidebar}
            onNew={() => tabs.newConversation()}
            onChoose={shell.chooseProject}
            onSettings={() => tabs.openSettings()}
            onSelect={shell.selectThread}
          />
        }
      >
        {state.tabs
          .filter((tab) => tab.kind === "conversation")
          .map((tab) => (
            <section
              key={tab.id}
              id={`panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`tab-${tab.id}`}
              className={cn("min-h-0 flex-1 flex-col", active.id === tab.id ? "flex" : "hidden")}
            >
              <ConversationPanel
                tab={tab}
                desktop={desktop}
                navigation={navigation}
                active={active.id === tab.id}
                version={version}
                onPreview={savePreview}
              />
            </section>
          ))}
      </DesktopLayout>
    </div>
  );
}

function SettingsLoading({ error }: { error?: string | null }) {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
      {error ?? "正在打开设置…"}
    </div>
  );
}
