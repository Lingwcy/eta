import { useEffect } from "react";
import type { ConversationTab } from "@/agent/desktop-tabs";
import type { DesktopLibraryController } from "@/agent/use-desktop-library";
import type { DesktopTabController } from "@/agent/use-desktop-tabs";
import { useDesktopController } from "@/agent/use-desktop-controller";
import { ThinkingSlot } from "@/components/agent-thinking/thinking-slot";
import { CompositeInput } from "@/components/input";
import { ComposerContext } from "@/components/input/composer-context";
import { ChatTranscript } from "@/components/chat/chat-transcript";
import { ChatWelcome } from "@/components/chat/chat-welcome";
import { RecoveryNotice } from "@/components/chat/recovery-notice";
import { Alert } from "@/components/ui/alert";
import { SkillPicker } from "@/components/input/skill-picker";

export function ConversationPanel({
  tab,
  desktop,
  navigation,
  active,
  version,
  onPreview,
}: {
  tab: ConversationTab;
  desktop: DesktopLibraryController;
  navigation: DesktopTabController;
  active: boolean;
  version: number;
  onPreview: (id: string, text: string) => void;
}) {
  const view = useDesktopController(tab, desktop, navigation, active, version);
  const messages = view.transcript.snapshot?.transcript;
  const running = view.transcript.running;
  useEffect(() => {
    if (running || !messages) return;
    const last = messages.findLast((entry) => entry.message.role === "user");
    const content = last?.message.content;
    const text =
      typeof content === "string"
        ? content
        : content?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    if (text) onPreview(tab.id, text.slice(0, 600));
  }, [messages, running, onPreview, tab.id]);
  return (
    <>
      <ChatTranscript {...view.transcript}>
        {view.welcome && <ChatWelcome {...view.welcome} />}
        {view.failure && <Alert>{view.failure}</Alert>}
        {view.recovery && <RecoveryNotice {...view.recovery} />}
        {view.stopped && <output className="text-xs text-neutral-500">已停止生成</output>}
        <ThinkingSlot thinking={view.thinking} />
      </ChatTranscript>
      <div className="w-full shrink-0 px-5 pb-4 min-[901px]:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          {view.composerContext && <ComposerContext {...view.composerContext} />}
          <CompositeInput
            {...view.composer}
            skillsControl={
              <SkillPicker
                active={active}
                disabled={Boolean(view.composer.disabled || running)}
                cwd={
                  desktop.library?.threads.find((thread) => thread.id === tab.threadId)?.sessionRef
                    .metadata.cwd ?? view.composer.cwd
                }
                threadId={tab.threadId}
                activeSkills={view.transcript.snapshot?.activeSkills}
                onSettings={() => navigation.tabs.openSettings("skills")}
                onSelect={(name) =>
                  view.composer.onChange(`${view.composer.value.trimEnd()} $${name} `.trimStart())
                }
              />
            }
          />
        </div>
      </div>
    </>
  );
}
