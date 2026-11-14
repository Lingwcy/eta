import { useState } from "react";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import {
  ChevronDown,
  ChevronRight,
  CircleX,
  FileCode2,
  FilePenLine,
  FileText,
  Globe,
  Search,
  Terminal,
  Wrench,
} from "lucide-react-native";
import { getToolSummary, textContent, toolStateLabel } from "../conversation.ts";
import { useI18n } from "../i18n/index.ts";
import { FadeSlideIn } from "../motion.tsx";
import { radii } from "../theme.ts";
import { colors, ScrollArea } from "../ui.tsx";

export function ToolIcon({ name, size, color }: { name: string; size: number; color: string }) {
  const lower = name.toLowerCase();
  if (lower.includes("read") || lower === "view") {
    return <FileText size={size} strokeWidth={1.85} color={color} />;
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("patch")) {
    return <FilePenLine size={size} strokeWidth={1.85} color={color} />;
  }
  if (
    lower.includes("search") ||
    lower.includes("find") ||
    lower.includes("grep") ||
    lower.includes("glob")
  ) {
    return <Search size={size} strokeWidth={1.85} color={color} />;
  }
  if (
    lower.includes("bash") ||
    lower.includes("exec") ||
    lower.includes("run") ||
    lower.includes("shell") ||
    lower.includes("terminal")
  ) {
    return <Terminal size={size} strokeWidth={1.85} color={color} />;
  }
  if (lower.includes("web") || lower.includes("fetch") || lower.includes("browse")) {
    return <Globe size={size} strokeWidth={1.85} color={color} />;
  }
  if (lower === "codemode") {
    return <FileCode2 size={size} strokeWidth={1.85} color={color} />;
  }
  return <Wrench size={size} strokeWidth={1.85} color={color} />;
}

export function ToolCard({
  name,
  args,
  description,
  result,
  status,
  showIcon = true,
}: {
  name: string;
  args?: Record<string, unknown>;
  description?: string;
  result?: {
    content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  status: string;
  showIcon?: boolean;
}) {
  const { m } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const isError = Boolean(result?.isError);
  const active = status === "running" || status === "generating" || status === "pending";
  const waiting = status === "waiting";
  const state = toolStateLabel(status, { isError });
  const summaryText = description ?? getToolSummary(name, args);
  const displayTitle = description ?? (summaryText ? `${name} · ${summaryText}` : name);
  const hasArgs = Boolean(args && Object.keys(args).length > 0);
  const hasDetails = hasArgs || Boolean(result) || (active && !result);

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={m.toolCard.accessibilityLabel(name, summaryText, state, expanded)}
        onPress={() => setExpanded((current) => !current)}
        hitSlop={4}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        {showIcon && (
          <View style={styles.iconBox}>
            {isError ? (
              <CircleX size={14} strokeWidth={1.9} color={colors.danger} />
            ) : (
              <ToolIcon name={name} size={14} color={active ? colors.ink : colors.secondary} />
            )}
          </View>
        )}
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.summary, active && styles.summaryActive, isError && styles.errorText]}
        >
          {displayTitle}
        </Text>
        {status !== "settled" && (
          <View
            style={[
              styles.statePill,
              isError && styles.statePillError,
              active && styles.statePillActive,
              waiting && styles.statePillWaiting,
            ]}
          >
            <Text
              style={[
                styles.stateText,
                isError && styles.stateTextError,
                active && styles.stateTextActive,
                waiting && styles.stateTextWaiting,
              ]}
            >
              {state}
            </Text>
          </View>
        )}
        <View style={styles.chevronBox}>
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2} color={colors.tertiary} />
          ) : (
            <ChevronRight size={14} strokeWidth={2} color={colors.caption} />
          )}
        </View>
      </Pressable>

      {expanded && hasDetails && (
        <FadeSlideIn offset={4} duration={150} style={styles.detailsPanel}>
          <ScrollArea maxHeight={220} contentContainerStyle={styles.detailsScroll}>
            {hasArgs && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionDot} />
                  <Text style={styles.sectionTitle}>{m.toolCard.argsTitle}</Text>
                </View>
                <Text selectable style={styles.codeText}>
                  {JSON.stringify(args, null, 2)}
                </Text>
              </View>
            )}
            {hasArgs && (result || (active && !result)) && <View style={styles.sectionDivider} />}
            {result && (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <View
                    style={[
                      styles.sectionDot,
                      isError ? styles.sectionDotError : styles.sectionDotSuccess,
                    ]}
                  />
                  <Text style={[styles.sectionTitle, isError && styles.errorText]}>
                    {isError ? m.toolCard.resultError : m.toolCard.resultOk}
                  </Text>
                </View>
                <Text selectable style={[styles.codeText, isError && styles.errorText]}>
                  {textContent({
                    role: "toolResult",
                    content: result.content,
                    isError: result.isError,
                  }) || m.toolCard.emptyOutput}
                </Text>
                {typeof result.content !== "string" &&
                  result.content
                    .filter((part) => part.type === "image" && part.data && part.mimeType)
                    .map((part, index) => (
                      <Image
                        key={index}
                        accessibilityLabel={m.toolCard.imageAlt}
                        source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
                        resizeMode="contain"
                        style={styles.toolImage}
                      />
                    ))}
              </View>
            )}
            {active && !result && (
              <View style={styles.section}>
                <Text style={styles.runningHint}>{state}</Text>
              </View>
            )}
          </ScrollArea>
        </FadeSlideIn>
      )}
    </View>
  );
}

const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  card: {
    minWidth: 0,
  },
  row: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 3,
    paddingHorizontal: 2,
    borderRadius: radii.xs,
  },
  rowPressed: {
    backgroundColor: colors.soft,
  },
  iconBox: {
    width: 18,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  summary: {
    flex: 1,
    minWidth: 0,
    fontSize: 13.5,
    lineHeight: 20,
    fontWeight: "500",
    color: colors.secondary,
  },
  summaryActive: {
    color: colors.text,
  },
  statePill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    flexShrink: 0,
  },
  statePillActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  statePillWaiting: {
    backgroundColor: colors.warningSoft,
    borderColor: "#FDE68A",
  },
  statePillError: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerBorder,
  },
  stateText: {
    fontSize: 10.5,
    lineHeight: 14,
    fontWeight: "600",
    color: colors.secondary,
  },
  stateTextActive: {
    color: colors.surface,
  },
  stateTextWaiting: {
    color: colors.warning,
  },
  stateTextError: {
    color: colors.danger,
  },
  chevronBox: {
    width: 18,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  detailsPanel: {
    marginTop: 6,
    marginBottom: 8,
    borderRadius: 12,
    backgroundColor: colors.codeBg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  detailsScroll: {
    flexGrow: 0,
  },
  section: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  sectionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.tertiary,
  },
  sectionDotSuccess: {
    backgroundColor: colors.success,
  },
  sectionDotError: {
    backgroundColor: colors.danger,
  },
  sectionTitle: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "600",
    color: colors.tertiary,
  },
  codeText: {
    fontSize: 12,
    lineHeight: 17.5,
    color: colors.inkSoft,
    fontFamily: monoFont,
  },
  runningHint: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.tertiary,
  },
  toolImage: {
    marginTop: 6,
    height: 176,
    width: "100%",
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorText: {
    color: colors.danger,
  },
});
