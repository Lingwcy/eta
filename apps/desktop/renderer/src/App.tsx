import { ScheduleForm } from "@/components/schedules/schedule-form";
import { DesktopInspector } from "@/components/inspector/desktop-inspector";
import { SubagentControls } from "@/components/subagents/subagent-controls";
import { ThreadActionsProvider } from "@/components/threads/thread-actions";
import { useDesktopShell } from "@/agent/use-desktop-shell";
import { DesktopTabBar } from "@/components/tabs/desktop-tab-bar";
import { DesktopPanels } from "@/components/tabs/desktop-panels";
import { GitHubPanel } from "@/components/projects/github-panel";
import { InspectorTabs } from "@/components/inspector/inspector-tabs";
import { ToastNotice } from "@/components/ui/toast";
import { useTranslation } from "react-i18next";
import { lazy, Suspense } from "react";

const DiffPanel = lazy(() =>
  import("@/components/diff/diff-panel").then((module) => ({ default: module.DiffPanel })),
);

export function App() {
  useTranslation();
  const shell = useDesktopShell();
  const conversation = shell.inspectorConversation;
  return (
    <ThreadActionsProvider
      desktop={shell.desktop}
      onOverlay={shell.setThreadOverlay}
      onSchedule={shell.addSchedule}
    >
      <ToastNotice message={shell.desktop.error} />
      {shell.creatingSchedule && shell.desktop.library && (
        <ScheduleForm
          key={shell.creatingSchedule}
          library={shell.desktop.library}
          controller={shell.schedules}
          threadId={shell.creatingSchedule}
          workspaceId={
            shell.desktop.library.threads.find((thread) => thread.id === shell.creatingSchedule)
              ?.workspaceId
          }
          onCancel={shell.finishSchedule}
          onSaved={(id) => void shell.scheduleSaved(id)}
        />
      )}
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
            <DesktopInspector open={shell.inspectorOpen} content={shell.inspectorContent}>
              <InspectorTabs
                value={shell.inspectorContent}
                onChange={shell.selectInspectorContent}
                diff={
                  shell.diff.available ? (
                    <Suspense fallback={null}>
                      <DiffPanel
                        workspaceId={shell.diff.workspaceId}
                        history={shell.diff.history}
                        active={shell.inspectorOpen && shell.inspectorContent === "diff"}
                        revision={shell.diff.revision}
                        workspace={shell.diff.workspace}
                        onWorkspaceSelect={shell.diff.showWorkspace}
                        connectionKey={shell.diff.connectionKey}
                      />
                    </Suspense>
                  ) : undefined
                }
                github={
                  shell.github.available && shell.github.project ? (
                    <GitHubPanel
                      key={shell.github.project.id}
                      client={shell.github.client}
                      projectId={shell.github.project.id}
                      name={shell.github.project.name}
                      info={shell.github.info}
                      connected={shell.github.connected}
                      onRefresh={shell.github.refresh}
                      onRemote={shell.github.selectRemote}
                    />
                  ) : undefined
                }
                subagents={
                  shell.subagents.length > 0 ? (
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
                  ) : undefined
                }
              />
            </DesktopInspector>
          )}
        </div>
      </div>
    </ThreadActionsProvider>
  );
}
