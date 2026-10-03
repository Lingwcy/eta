import { lazy, Suspense } from "react";
import { useDesktopController } from "@/agent/use-desktop-controller";
import { DesktopLayout } from "@/components/desktop-layout";
import { WindowToolbar } from "@/components/window-toolbar";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { AgentThinking } from "@/components/agent-thinking";
import { CompositeInput } from "@/components/input";
import { ComposerContext } from "@/components/input/composer-context";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { ChatWelcome } from "@/components/chat/chat-welcome";
import { ThreadHeader } from "@/components/chat/thread-header";
import { RecoveryNotice } from "@/components/chat/recovery-notice";
import { Alert } from "@/components/ui/alert";

const DesktopSettings = lazy(() =>
  import("@/components/desktop-settings").then((module) => ({ default: module.DesktopSettings })),
);

export function App() {
  const view = useDesktopController();
  return (
    <>
      <div hidden={!!view.settings}>
        <DesktopLayout
          collapsed={view.collapsed}
          toolbar={<WindowToolbar {...view.toolbar} />}
          sidebar={<DesktopSidebar {...view.sidebar} />}
        >
          {view.threadHeader && <ThreadHeader {...view.threadHeader} />}
          <ChatTranscript key={view.transcriptKey} {...view.transcript}>
            {view.welcome && <ChatWelcome {...view.welcome} />}
            {view.failure && <Alert>{view.failure}</Alert>}
            {view.recovery && <RecoveryNotice {...view.recovery} />}
            {view.stopped && <output className="text-xs text-neutral-500">已停止生成</output>}
          </ChatTranscript>
          <div className="mx-auto w-full max-w-[780px] shrink-0 px-4 pb-4 min-[901px]:px-6 min-[1600px]:max-w-[880px]">
            {view.thinking && (
              <div className="px-3 py-1">
                <AgentThinking {...view.thinking} />
              </div>
            )}
            <ComposerContext {...view.composerContext} />
            <CompositeInput key={view.composerKey} {...view.composer} />
          </div>
        </DesktopLayout>
      </div>
      <Suspense fallback={null}>{view.settings && <DesktopSettings {...view.settings} />}</Suspense>
    </>
  );
}
