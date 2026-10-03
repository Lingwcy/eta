import { lazy, Suspense } from "react";
import { useDesktopController } from "@/agent/use-desktop-controller";
import { DesktopLayout } from "@/components/desktop-layout";
import { WindowToolbar } from "@/components/window-toolbar";
import { DesktopSidebar } from "@/components/desktop-sidebar";
import { ThinkingSlot } from "@/components/agent-thinking/thinking-slot";
import { CompositeInput } from "@/components/input";
import { ComposerContext } from "@/components/input/composer-context";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { ChatWelcome } from "@/components/chat/chat-welcome";
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
          <ChatTranscript key={view.transcriptKey} {...view.transcript}>
            {view.welcome && <ChatWelcome {...view.welcome} />}
            {view.failure && <Alert>{view.failure}</Alert>}
            {view.recovery && <RecoveryNotice {...view.recovery} />}
            {view.stopped && <output className="text-xs text-neutral-500">已停止生成</output>}
            <ThinkingSlot thinking={view.thinking} />
          </ChatTranscript>
          <div className="w-full shrink-0 px-5 pb-4 min-[901px]:px-8">
            <div className="mx-auto w-full max-w-[960px]">
              {view.composerContext && (
                <ComposerContext key={`context:${view.composerKey}`} {...view.composerContext} />
              )}
              <CompositeInput key={`input:${view.composerKey}`} {...view.composer} />
            </div>
          </div>
        </DesktopLayout>
      </div>
      <Suspense fallback={null}>{view.settings && <DesktopSettings {...view.settings} />}</Suspense>
    </>
  );
}
