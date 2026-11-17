import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Brain, ChevronDown, ChevronRight, CircleX } from "lucide-react-native";
import type { AssistantReplyView, AssistantStep, ToolStep } from "../conversation.ts";
import { getMessages, useI18n } from "../i18n/index.ts";
import { FadeSlideIn } from "../motion.tsx";
import { radii } from "../theme.ts";
import { colors } from "../ui.tsx";
import { ThrottledMarkdown } from "./markdown.tsx";
import { ToolCard, ToolIcon } from "./tool-card.tsx";

function activeToolTitle(step: ToolStep) {
  const name = (step.part.name ?? "").toLowerCase();
  if (
    name.includes("search") ||
    name.includes("find") ||
    name.includes("grep") ||
    name.includes("glob")
  ) {
    return getMessages().replyArea.searching;
  }
  if (name.includes("web") || name.includes("fetch") || name.includes("browse")) {
    return getMessages().replyArea.browsing;
  }
  if (name.includes("read") || name === "view") {
    return getMessages().replyArea.reading;
  }
  if (name.includes("write") || name.includes("edit") || name.includes("patch")) {
    return getMessages().replyArea.writing;
  }
  if (
    name.includes("bash") ||
    name.includes("exec") ||
    name.includes("run") ||
    name.includes("shell")
  ) {
    return getMessages().replyArea.runningCmd;
  }
  return getMessages().replyArea.callingTool;
}

function useAreaTitle(view: AssistantReplyView): { title: string | null; active: boolean } {
  const { m } = useI18n();
  const startedAtRef = useRef<number | null>(null);
  const endedAtRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  const thinkingActive = view.streaming && view.hasThinking && !view.answer;
  useEffect(() => {
    if (thinkingActive && startedAtRef.current === null) {
      startedAtRef.current = Date.now();
      endedAtRef.current = null;
    } else if (!thinkingActive && startedAtRef.current !== null && endedAtRef.current === null) {
      endedAtRef.current = Date.now();
    }
  }, [thinkingActive]);

  const titleActive = view.streaming && !view.answer;
  useEffect(() => {
    if (!titleActive || !view.hasThinking) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [titleActive, view.hasThinking]);

  if (!view.hasThinking) return { title: null, active: false };

  if (view.answer) {
    if (startedAtRef.current !== null) {
      const elapsed = Math.max(
        1,
        Math.round(((endedAtRef.current ?? Date.now()) - startedAtRef.current) / 1000),
      );
      return { title: m.replyArea.thoughtDuration(elapsed), active: false };
    }
    return { title: m.replyArea.thoughtProcess, active: false };
  }

  if (!view.streaming || view.stoppedWithoutAnswer) {
    return {
      title: view.stoppedWithoutAnswer ? m.replyArea.stopped : m.replyArea.thoughtProcess,
      active: false,
    };
  }

  const last = view.steps.at(-1);
  if (
    last?.type === "tool" &&
    (last.status === "running" || last.status === "generating" || last.status === "pending")
  ) {
    return { title: activeToolTitle(last), active: true };
  }
  return { title: m.replyArea.thinkingActive, active: true };
}

function TimelineContentStep({
  text,
  active,
  streaming,
  isLast,
}: {
  text: string;
  active: boolean;
  streaming: boolean;
  isLast: boolean;
}) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.rail}>
        <View style={styles.dotSlot}>
          <View style={[styles.dotInner, active && styles.dotActive]} />
        </View>
        {!isLast && <View style={styles.railLine} />}
      </View>
      <View style={[styles.stepBody, isLast && styles.stepBodyLast]}>
        <ThrottledMarkdown content={text} streaming={streaming} thinking />
      </View>
    </View>
  );
}

function ToolStepRow({ step, isLast }: { step: ToolStep; isLast: boolean }) {
  const { part, result, running, status, description, nested } = step;
  const isError = result?.isError ?? running?.isError ?? false;
  const active = status === "running" || status === "generating" || status === "pending";
  const showOuter =
    part.name !== "codemode" ||
    !nested.length ||
    result?.isError ||
    running?.isError ||
    running?.status === "waiting" ||
    (Array.isArray(result?.content) && result.content.some((item) => item.type === "image")) ||
    running?.result?.content.some((item) => item.type === "image");

  return (
    <View style={styles.stepRow}>
      <View style={styles.rail}>
        <View style={styles.iconSlot}>
          {isError ? (
            <CircleX size={14} strokeWidth={1.9} color={colors.danger} />
          ) : (
            <ToolIcon
              name={part.name ?? getMessages().replyArea.fallbackToolName}
              size={14}
              color={active ? colors.ink : colors.secondary}
            />
          )}
        </View>
        {!isLast && <View style={styles.railLine} />}
      </View>
      <View style={[styles.stepBody, isLast && styles.stepBodyLast]}>
        {showOuter && (
          <ToolCard
            name={part.name ?? getMessages().replyArea.fallbackToolName}
            args={
              running?.args && Object.keys(running.args).length > 0 ? running.args : part.arguments
            }
            description={description}
            result={result}
            status={status}
            showIcon={false}
          />
        )}
        {nested.length > 0 && (
          <View style={[styles.nestedGroup, showOuter && styles.nestedGroupIndented]}>
            {nested.map((child, idx) => (
              <ToolCard
                key={`${child.id}:${idx}`}
                name={child.name}
                args={child.args}
                description={child.description}
                result={child.result}
                status={child.status}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * Monochrome timeline area for assistant thinking prose, preamble notes, and tool calls.
 */
export function ReplyArea({ view }: { view: AssistantReplyView }) {
  const { m } = useI18n();
  const [open, setOpen] = useState(true);
  const { title, active } = useAreaTitle(view);

  if (view.steps.length === 0) return null;

  return (
    <View style={styles.area}>
      {title && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={title}
          onPress={() => setOpen((value) => !value)}
          style={({ pressed }) => [styles.areaTitleRow, pressed && styles.areaTitlePressed]}
        >
          <Brain
            size={15}
            strokeWidth={1.85}
            color={
              view.stoppedWithoutAnswer ? colors.tertiary : active ? colors.ink : colors.secondary
            }
          />
          <Text style={[styles.areaTitleText, active && styles.areaTitleActive]}>{title}</Text>
          {open ? (
            <ChevronDown size={14} strokeWidth={2} color={colors.tertiary} />
          ) : (
            <ChevronRight size={14} strokeWidth={2} color={colors.tertiary} />
          )}
        </Pressable>
      )}
      {(open || !title) && (
        <FadeSlideIn offset={4} duration={150} style={styles.steps}>
          {view.steps.map((step: AssistantStep, index: number) => {
            const isLast = index === view.steps.length - 1;
            if (step.type === "thinking") {
              return (
                <TimelineContentStep
                  key={step.key}
                  text={step.thinking}
                  active={step.active}
                  streaming={view.streaming && isLast}
                  isLast={isLast}
                />
              );
            }
            if (step.type === "text") {
              return (
                <TimelineContentStep
                  key={step.key}
                  text={step.text}
                  active={false}
                  streaming={view.streaming && isLast}
                  isLast={isLast}
                />
              );
            }
            if (step.type === "tool") {
              return <ToolStepRow key={step.key} step={step} isLast={isLast} />;
            }
            return (
              <Text key={step.key} style={styles.fallbackContent}>
                {m.message.fallbackContent(step.partType)}
              </Text>
            );
          })}
        </FadeSlideIn>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  area: {
    marginBottom: 8,
  },
  areaTitleRow: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 8,
    marginLeft: -8,
    borderRadius: radii.full,
    marginBottom: 4,
  },
  areaTitlePressed: {
    backgroundColor: colors.soft,
  },
  areaTitleText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    color: colors.secondary,
  },
  areaTitleActive: {
    color: colors.ink,
    fontWeight: "600",
  },
  steps: {
    paddingTop: 2,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: 10,
  },
  rail: {
    width: 20,
    alignItems: "center",
    position: "relative",
    flexShrink: 0,
  },
  dotSlot: {
    width: 20,
    height: 21,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  dotInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.caption,
  },
  dotActive: {
    backgroundColor: colors.ink,
  },
  iconSlot: {
    width: 20,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
    backgroundColor: colors.background,
  },
  railLine: {
    flex: 1,
    width: 1.5,
    backgroundColor: colors.rail,
    marginTop: 1,
    marginBottom: 1,
  },
  stepBody: {
    flex: 1,
    minWidth: 0,
    paddingBottom: 8,
  },
  stepBodyLast: {
    paddingBottom: 2,
  },
  nestedGroup: {
    gap: 4,
  },
  nestedGroupIndented: {
    marginTop: 4,
    paddingLeft: 10,
    borderLeftWidth: 1.5,
    borderLeftColor: colors.rail,
  },
  fallbackContent: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.tertiary,
  },
});
