import { DesktopInspector } from "@/components/inspector/desktop-inspector";
import { SubagentControls } from "@/components/subagents/subagent-controls";
import { ThreadActionsProvider } from "@/components/threads/thread-actions";
import { useDesktopShell } from "@/agent/use-desktop-shell";
import { DesktopTabBar } from "@/components/tabs/desktop-tab-bar";
import { DesktopPanels } from "@/components/tabs/desktop-panels";

export function App() {
  const shell = useDesktopShell();
  const conversation = shell.inspectorConversation;
  return (
    <ThreadActionsProvider desktop={shell.desktop} onOverlay={shell.setThreadOverlay}>
      <div className="flex h-dvh flex-col overflow-hidden bg-[#e9e9e9] font-sans text-[#292b2e] antialiased [--rail-width:50px] [--sidebar-width:170px] min-[701px]:[--sidebar-width:190px] min-[901px]:[--sidebar-width:210px] min-[1600px]:[--sidebar-width:230px]">
        <DesktopTabBar
          state={shell.navigation.state}
          tabs={shell.navigation.tabs}
          items={shell.items}
          collapsed={shell.collapsed}
          onToggle={shell.toggleSidebar}
          inspectorAvailable={shell.inspectorAvailable}
          inspectorOpen={shell.inspectorOpen}
          onToggleInspector={shell.toggleInspector}
          onOverlay={shell.setOverlay}
          onPreview={shell.browser.capture}
        />
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <DesktopPanels shell={shell} />
          </div>
          {shell.inspectorAvailable && (
            <DesktopInspector open={shell.inspectorOpen}>
              <SubagentControls
                agents={shell.subagents}
                selected={
                  conversation?.threadId
                    ? shell.selectedSubagents[conversation.threadId]
                    : undefined
                }
                onSelect={(path) => {
                  if (!conversation?.threadId) return;
                  shell.selectSubagent(conversation.threadId, path);
                  shell.navigation.tabs.select(conversation.id);
                }}
              />
            </DesktopInspector>
          )}
        </div>
      </div>
    </ThreadActionsProvider>
  );
}
