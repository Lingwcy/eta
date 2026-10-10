import { SubagentConversation } from "@/components/subagents/subagent-conversation";
import { useEffect, useState } from "react";
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
  selectedSubagent,
  onRoot,
}: {
  tab: ConversationTab;
  desktop: DesktopLibraryController;
  navigation: DesktopTabController;
  active: boolean;
  version: number;
  onPreview: (id: string, text: string) => void;
  selectedSubagent?: string;
  onRoot: () => void;
}) {
  const view = useDesktopController(tab, desktop, navigation, active, version);
  const [visitedChildren, setVisitedChildren] = useState<ReadonlySet<string>>(new Set());
  const [childDrafts, setChildDrafts] = useState<Record<string, string>>({});
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
  const child = view.transcript.snapshot?.subagents?.find(
    (child) => child.path === selectedSubagent,
  );
  const childKey = `${tab.threadId}:${child?.path}`;
  useEffect(() => {
    if (!child) return;
    setVisitedChildren((current) =>
      current.has(childKey) ? current : new Set([...current, childKey]),
    );
  }, [child, childKey]);
  return (
    <>
      {tab.threadId &&
        view.transcript.snapshot?.subagents
          ?.filter(
            (candidate) =>
              candidate.path === child?.path ||
              visitedChildren.has(`${tab.threadId}:${candidate.path}`),
          )
          .map((candidate) => {
            const key = `${tab.threadId}:${candidate.path}`;
            const visible = child?.path === candidate.path;
            return (
              <div key={key} className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
                <SubagentConversation
                  threadId={tab.threadId!}
                  library={desktop.library}
                  child={candidate}
                  draft={childDrafts[key] ?? ""}
                  onDraft={(draft) => setChildDrafts((current) => ({ ...current, [key]: draft }))}
                  active={active && visible}
                  blocked={Boolean(
                    view.transcript.snapshot?.recoveryRequired ||
                    view.transcript.snapshot?.blockedReason,
                  )}
                  onBack={onRoot}
                />
              </div>
            );
          })}
      <div className={child ? "hidden" : "contents"}>
        <ChatTranscript {...view.transcript}>
          {view.welcome && <ChatWelcome {...view.welcome} />}
          {view.failure && <Alert>{view.failure}</Alert>}
          {view.recovery && <RecoveryNotice {...view.recovery} />}
          {view.stopped && <output className="text-xs text-neutral-500">已停止生成</output>}
          <ThinkingSlot
            thinking={
              view.thinking && {
                ...view.thinking,
                variant: desktop.library?.settings.agentThinkingVariant ?? "wave",
                active: active && !child,
              }
            }
          />
        </ChatTranscript>
        <div className="w-full shrink-0 px-5 pb-4 min-[901px]:px-8">
          <div className="mx-auto w-full max-w-[960px]">
            {view.composerContext && <ComposerContext {...view.composerContext} />}
            <CompositeInput
              {...view.composer}
              skillsControl={
                <SkillPicker
                  active={active}
                  disabled={Boolean(
                    view.composer.disabled || running || (view.composer.cloud && !tab.workspaceId),
                  )}
                  cwd={
                    desktop.library?.threads.find((thread) => thread.id === tab.threadId)
                      ?.sessionRef.metadata.cwd ?? view.composer.cwd
                  }
                  workspaceId={tab.workspaceId}
                  threadId={tab.threadId}
                  activeSkills={view.transcript.snapshot?.activeSkills}
                  onSettings={() =>
                    navigation.tabs.openSettings(view.composer.cloud ? "bot" : "skills")
                  }
                  onSelect={(name) =>
                    view.composer.onChange(`${view.composer.value.trimEnd()} $${name} `.trimStart())
                  }
                />
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}
