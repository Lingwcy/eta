import { memo, useState } from "react";
import { Image, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import {
  Brain,
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
import type { BotMessage, BotSnapshot } from "../bot/contracts.ts";
import {
  getToolSummary,
  textContent,
  toolCallState,
  toolDescription,
  toolStateLabel,
  nestedTools,
  isActivityMessage,
  type ToolIndex,
} from "../conversation.ts";
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
  description,
}: {
  name: string;
  args?: Record<string, unknown>;
  result?: BotMessage;
  status?: string;
  description?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = description ?? getToolSummary(name, args);
  const isError = result?.isError ?? false;
  const state = toolStateLabel(status, result);
  const active = status === "running" || status === "generating" || status === "pending";

  return (
    <View style={styles.toolCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${name}${summary ? ` · ${summary}` : ""}，${state}，点击${expanded ? "收起" : "展开"}详情`}
        onPress={() => setExpanded(!expanded)}
        style={styles.toolRow}
      >
        {isError ? (
          <CircleX size={14} color={colors.danger} />
        ) : (
          <ToolIcon name={name} size={14} color={colors.muted} />
        )}
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          style={[styles.toolSummary, isError && styles.errorText]}
        >
          {description ?? (summary ? `${name} · ${summary}` : name)}
        </Text>
        {status !== "settled" && <Text style={styles.toolState}>{state}</Text>}
        {expanded ? (
          <ChevronDown size={14} color={colors.muted} />
        ) : (
          <ChevronRight size={14} color={colors.muted} />
        )}
      </Pressable>

      {expanded && (
        <ScrollArea maxHeight={240} contentContainerStyle={styles.toolScrollContent}>
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
          {active && !result && <Text style={styles.runningHint}>{state}</Text>}
        </ScrollArea>
      )}
    </View>
  );
}

function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.trim().split(/\r\n|\r|\n/, 1)[0] || "思考内容";
  return (
    <View style={styles.toolCard}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? "思考内容" : preview}，${active ? "正在思考，" : ""}点击${expanded ? "收起" : "展开"}思考内容`}
        onPress={() => setExpanded(!expanded)}
        style={styles.toolRow}
      >
        <Brain size={14} color={colors.muted} />
        <Text numberOfLines={1} ellipsizeMode="tail" style={styles.toolSummary}>
          {expanded ? "思考内容" : preview}
        </Text>
        {active && <Text style={styles.toolState}>正在思考</Text>}
        {expanded ? (
          <ChevronDown size={14} color={colors.muted} />
        ) : (
          <ChevronRight size={14} color={colors.muted} />
        )}
      </Pressable>
      {expanded && (
        <ScrollArea maxHeight={240} contentContainerStyle={styles.toolScrollContent}>
          <Text selectable style={styles.thinkingText}>
            {text}
          </Text>
        </ScrollArea>
      )}
    </View>
  );
}

export const MessageView = memo(function MessageView({
  message,
  snapshot,
  tools,
  compactAfter = false,
}: {
  message: BotMessage;
  snapshot: BotSnapshot;
  tools: ToolIndex;
  compactAfter?: boolean;
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
    <View
      style={[
        styles.message,
        isActivityMessage(message) && styles.activityMessage,
        compactAfter && styles.compactAfter,
        user && styles.userMessage,
      ]}
    >
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
          const result = tools.results.get(part.id)?.message;
          const running = part.id === undefined ? undefined : tools.running.get(part.id);
          const stopped = tools.messages.get(message)?.toolStatus;
          const nested = nestedTools(snapshot, part.id, tools);
          const showOuter =
            part.name !== "codemode" ||
            !nested.length ||
            result?.isError ||
            running?.isError ||
            running?.status === "waiting" ||
            (Array.isArray(result?.content) &&
              result.content.some((item) => item.type === "image")) ||
            running?.result?.content.some((item) => item.type === "image");
          return (
            <View key={part.id ?? index}>
              {showOuter && (
                <ToolCard
                  name={part.name ?? "工具"}
                  args={part.arguments}
                  result={result}
                  description={toolDescription(snapshot, part.id, running?.description)}
                  status={
                    running?.status ?? stopped ?? toolCallState(snapshot, message, part.id, tools)
                  }
                />
              )}
              <View style={showOuter ? styles.nestedTools : undefined}>
                {nested.map((tool) => (
                  <ToolCard
                    key={tool.id}
                    name={tool.name}
                    args={tool.args}
                    description={tool.description}
                    status={tool.status}
                    result={tool.result}
                  />
                ))}
              </View>
            </View>
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
  nestedTools: { marginLeft: 16 },
  activityMessage: { gap: 2 },
  compactAfter: { marginBottom: 2 },
  message: {
    marginBottom: 22,
    gap: 6,
    alignSelf: "stretch",
  },
  userMessage: {
    alignSelf: "flex-end",
    maxWidth: "80%",
    backgroundColor: "#F4F4F4",
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: {
    fontSize: 16,
    lineHeight: 22,
    color: colors.text,
  },
  messageImage: {
    width: 240,
    maxWidth: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fallbackContent: {
    color: colors.muted,
    fontSize: 14,
  },
  errorMessage: {
    color: colors.danger,
    fontSize: 14,
    lineHeight: 20,
    paddingTop: 4,
  },
  thinkingText: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
  },
  toolCard: { marginVertical: 1, overflow: "hidden" },
  toolRow: {
    height: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 2,
  },
  toolSummary: { flex: 1, fontSize: 14, color: colors.muted },
  toolState: { fontSize: 13, color: colors.muted },
  toolScrollContent: {
    padding: 10,
    gap: 8,
  },
  toolSection: {
    gap: 4,
  },
  toolSectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
  },
  codeText: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 13,
    lineHeight: 19,
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
    fontSize: 16,
    lineHeight: 26,
  },
  heading1: {
    fontSize: 22,
    fontWeight: "600",
    color: colors.text,
    marginTop: 14,
    marginBottom: 6,
  },
  heading2: {
    fontSize: 19,
    fontWeight: "600",
    color: colors.text,
    marginTop: 12,
    marginBottom: 6,
  },
  heading3: {
    fontSize: 17,
    fontWeight: "600",
    color: colors.text,
    marginTop: 10,
    marginBottom: 4,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 12,
    fontSize: 16,
    lineHeight: 26,
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
    fontSize: 14,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
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
    marginVertical: 4,
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
