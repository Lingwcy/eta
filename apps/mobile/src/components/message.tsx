import { memo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  FileCode2,
  FilePenLine,
  FileText,
  Globe,
  Search,
  Terminal,
  Wrench,
} from "lucide-react-native";
import type { BotMessage, BotSnapshot } from "../bot/contracts.ts";
import { getToolSummary, textContent } from "../conversation.ts";
import { colors, ScrollArea } from "../ui.tsx";

function ToolIcon({ name, size = 14, color }: { name: string; size?: number; color: string }) {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "shell" || lower === "exec") {
    return <Terminal size={size} color={color} />;
  }
  if (lower === "edit" || lower.includes("edit")) {
    return <FilePenLine size={size} color={color} />;
  }
  if (lower === "write" || lower.includes("write")) {
    return <FileCode2 size={size} color={color} />;
  }
  if (lower === "read" || lower.includes("read") || lower === "view_file") {
    return <FileText size={size} color={color} />;
  }
  if (lower.includes("search") || lower === "grep" || lower === "find") {
    return <Search size={size} color={color} />;
  }
  if (lower.includes("url") || lower.includes("web") || lower.includes("browser")) {
    return <Globe size={size} color={color} />;
  }
  return <Wrench size={size} color={color} />;
}

export function ToolCard({
  name,
  args,
  result,
  status,
}: {
  name: string;
  args?: Record<string, unknown>;
  result?: BotMessage;
  status?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = getToolSummary(name, args);
  const isError = result?.isError ?? false;
  const isRunning = status === "running" || (status === undefined && !result);

  return (
    <View style={styles.toolCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${name}${summary ? ` · ${summary}` : ""}，点击${expanded ? "收起" : "展开"}详情`}
        onPress={() => setExpanded(!expanded)}
        style={styles.toolRow}
      >
        <ToolIcon name={name} size={14} color={colors.muted} />
        <Text style={styles.toolName}>{name}</Text>
        {!!summary && (
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.toolSummary}>
            {summary}
          </Text>
        )}
        <View style={styles.toolStatus}>
          {isRunning ? (
            <ActivityIndicator size="small" color={colors.text} style={styles.toolSpinner} />
          ) : isError ? (
            <CircleX size={14} color={colors.danger} />
          ) : status === "stopped" || status === "incomplete" || status === "waiting" ? (
            <CircleMinus size={14} color={colors.muted} />
          ) : (
            <CircleCheck size={14} color={colors.muted} />
          )}
        </View>
        {expanded ? (
          <ChevronDown size={14} color={colors.muted} />
        ) : (
          <ChevronRight size={14} color={colors.muted} />
        )}
      </Pressable>

      {expanded && (
        <ScrollArea
          maxHeight={220}
          style={styles.toolScrollArea}
          contentContainerStyle={styles.toolScrollContent}
        >
          {args && Object.keys(args).length > 0 && (
            <View style={styles.toolSection}>
              <Text style={styles.toolSectionTitle}>参数</Text>
              <Text selectable style={styles.codeText}>
                {JSON.stringify(args, null, 2)}
              </Text>
            </View>
          )}
          {result && (
            <View style={styles.toolSection}>
              <Text style={[styles.toolSectionTitle, isError && styles.errorText]}>
                {isError ? "执行失败" : "执行结果"}
              </Text>
              <Text selectable style={[styles.codeText, isError && styles.errorText]}>
                {textContent(result) || "（无文本输出）"}
              </Text>
              {typeof result.content !== "string" &&
                result.content
                  .filter((part) => part.type === "image" && part.data && part.mimeType)
                  .map((part, index) => (
                    <Image
                      key={index}
                      accessibilityLabel="工具返回的图片"
                      source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
                      resizeMode="contain"
                      style={styles.toolImage}
                    />
                  ))}
            </View>
          )}
          {isRunning && !result && <Text style={styles.runningHint}>正在执行中…</Text>}
        </ScrollArea>
      )}
    </View>
  );
}

function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.thinkingWrapper}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${active ? "正在思考" : "思考内容"}，点击${expanded ? "收起" : "展开"}`}
        onPress={() => setExpanded(!expanded)}
        style={styles.thinkingRow}
      >
        <Brain size={14} color={colors.muted} />
        <Text style={styles.thinkingTitle}>{active ? "正在思考…" : "思考过程"}</Text>
        {active && (
          <ActivityIndicator size="small" color={colors.muted} style={styles.toolSpinner} />
        )}
        {expanded ? (
          <ChevronDown size={14} color={colors.muted} />
        ) : (
          <ChevronRight size={14} color={colors.muted} />
        )}
      </Pressable>
      {expanded && (
        <View style={styles.thinkingContentWrapper}>
          <ScrollArea maxHeight={180}>
            <Text selectable style={styles.thinkingText}>
              {text}
            </Text>
          </ScrollArea>
        </View>
      )}
    </View>
  );
}

export const MessageView = memo(function MessageView({
  message,
  snapshot,
}: {
  message: BotMessage;
  snapshot: BotSnapshot;
}) {
  const user = message.role === "user";

  if (message.role === "toolResult") {
    return <ToolCard name={message.toolName ?? "工具结果"} result={message} />;
  }

  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  const isStreamingMessage =
    snapshot.operation?.status === "running" &&
    (message === snapshot.operation.streamingMessage ||
      (!message.stopReason && message.role === "assistant"));

  return (
    <View style={[styles.message, user && styles.userMessage]}>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return user ? (
            <Text key={index} selectable style={styles.userText}>
              {part.text}
            </Text>
          ) : (
            <Markdown
              key={index}
              style={markdownStyles}
              mergeStyle={false}
              onLinkPress={(url) => {
                if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(() => {});
                return false;
              }}
            >
              {part.text ?? ""}
            </Markdown>
          );
        }

        if (part.type === "thinking") {
          const isActive = Boolean(isStreamingMessage) && index === parts.length - 1;
          return <ThinkingBlock key={index} text={part.thinking ?? ""} active={isActive} />;
        }

        if (part.type === "toolCall") {
          const result = snapshot.transcript.find(
            ({ message: value }) => value.role === "toolResult" && value.toolCallId === part.id,
          )?.message;
          const running = snapshot.operation?.runningTools.find(
            (tool) => tool.toolCallId === part.id,
          );
          const stopped = snapshot.transcript.find(
            ({ message: value }) => value === message,
          )?.toolStatus;
          return (
            <ToolCard
              key={part.id ?? index}
              name={part.name ?? "工具"}
              args={part.arguments}
              result={result}
              status={running?.status ?? stopped ?? (!snapshot.operation ? "stopped" : undefined)}
            />
          );
        }

        if (part.type === "image" && part.data && part.mimeType) {
          return (
            <Image
              key={index}
              accessibilityLabel="消息中的图片"
              source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
              resizeMode="contain"
              style={styles.messageImage}
            />
          );
        }

        return (
          <Text key={index} style={styles.fallbackContent}>
            [{part.type} 内容]
          </Text>
        );
      })}

      {message.errorMessage && (
        <Text selectable style={styles.errorMessage}>
          {message.errorMessage}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  message: {
    marginBottom: 18,
    gap: 6,
    alignSelf: "stretch",
  },
  userMessage: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    backgroundColor: colors.soft,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  userText: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.text,
  },
  messageImage: {
    width: 240,
    height: 180,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackContent: {
    color: colors.muted,
    fontSize: 13,
  },
  errorMessage: {
    color: colors.danger,
    fontSize: 13,
    lineHeight: 19,
    paddingTop: 4,
  },
  // Thinking Component
  thinkingWrapper: {
    marginVertical: 4,
  },
  thinkingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 5,
  },
  thinkingTitle: {
    fontSize: 13,
    color: colors.muted,
    fontWeight: "500",
  },
  thinkingContentWrapper: {
    marginTop: 4,
    marginLeft: 4,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  thinkingText: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 20,
  },
  // Single-row Tool Component
  toolCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginVertical: 3,
    overflow: "hidden",
  },
  toolRow: {
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
  },
  toolName: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  toolSummary: {
    flex: 1,
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: colors.muted,
  },
  toolStatus: {
    alignItems: "center",
    justifyContent: "center",
  },
  toolSpinner: {
    transform: [{ scale: 0.75 }],
  },
  toolScrollArea: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.soft,
  },
  toolScrollContent: {
    padding: 10,
    gap: 8,
  },
  toolSection: {
    gap: 4,
  },
  toolSectionTitle: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  codeText: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 18,
    color: colors.text,
    backgroundColor: colors.surface,
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  errorText: {
    color: colors.danger,
    borderColor: colors.dangerSoft,
  },
  runningHint: {
    fontSize: 12,
    color: colors.muted,
    fontStyle: "italic",
  },
  toolImage: {
    width: 220,
    height: 160,
    borderRadius: 8,
    marginTop: 6,
  },
});

const markdownStyles = StyleSheet.create({
  body: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 24,
  },
  heading1: {
    fontSize: 20,
    fontWeight: "600",
    color: colors.text,
    marginTop: 14,
    marginBottom: 6,
  },
  heading2: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.text,
    marginTop: 12,
    marginBottom: 6,
  },
  heading3: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
    marginTop: 10,
    marginBottom: 4,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  strong: {
    fontWeight: "600",
    color: colors.text,
  },
  em: {
    fontStyle: "italic",
  },
  link: {
    color: colors.blue,
  },
  blockquote: {
    backgroundColor: colors.soft,
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    marginVertical: 6,
  },
  code_inline: {
    backgroundColor: colors.soft,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
  },
  fence: {
    backgroundColor: "#18181B",
    borderRadius: 12,
    padding: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 18,
    color: "#F4F4F5",
    marginVertical: 6,
  },
  code_block: {
    backgroundColor: "#18181B",
    borderRadius: 12,
    padding: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    lineHeight: 18,
    color: "#F4F4F5",
    marginVertical: 6,
  },
  bullet_list: {
    marginBottom: 8,
  },
  ordered_list: {
    marginBottom: 8,
  },
  list_item: {
    flexDirection: "row",
    justifyContent: "flex-start",
    marginVertical: 2,
  },
  bullet_list_icon: {
    marginRight: 6,
  },
  ordered_list_icon: {
    marginRight: 6,
  },
  bullet_list_content: {
    flex: 1,
  },
  ordered_list_content: {
    flex: 1,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    marginVertical: 8,
  },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  th: {
    flex: 1,
    padding: 6,
    fontWeight: "600",
  },
  td: {
    flex: 1,
    padding: 6,
  },
  hr: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 12,
  },
});
