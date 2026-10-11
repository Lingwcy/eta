import { memo, useState } from "react";
import { Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react-native";
import type { BotMessage, BotSnapshot } from "../bot/contracts.ts";
import { textContent } from "../conversation.ts";
import { colors } from "../ui.tsx";

function ToolCard({
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
  const label = result
    ? result.isError
      ? "失败"
      : "完成"
    : status === "stopped"
      ? "已停止"
      : status === "waiting"
        ? "等待中"
        : status === "settled"
          ? "已结束"
          : status === "incomplete"
            ? "未完成"
            : "执行中";
  return (
    <View style={styles.tool}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={styles.toolHeader}
      >
        <Terminal size={17} color={colors.muted} />
        <Text style={styles.toolName}>{name}</Text>
        <Text style={[styles.toolState, result?.isError && styles.error]}>{label}</Text>
        {expanded ? (
          <ChevronDown size={16} color={colors.muted} />
        ) : (
          <ChevronRight size={16} color={colors.muted} />
        )}
      </Pressable>
      {expanded && (
        <View style={styles.details}>
          {args && (
            <Text selectable style={styles.code}>
              {JSON.stringify(args, null, 2)}
            </Text>
          )}
          {result && (
            <Text selectable style={[styles.code, result.isError && styles.error]}>
              {textContent(result) || "工具未返回文本"}
            </Text>
          )}
          {result &&
            typeof result.content !== "string" &&
            result.content
              .filter((part) => part.type === "image" && part.data && part.mimeType)
              .map((part, index) => (
                <Image
                  key={index}
                  accessibilityLabel="工具返回的图片"
                  source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
                  resizeMode="contain"
                  style={styles.image}
                />
              ))}
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
  const [showThinking, setShowThinking] = useState(false);
  if (message.role === "toolResult")
    return <ToolCard name={message.toolName ?? "工具结果"} result={message} />;
  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
  return (
    <View style={[styles.message, user && styles.user]}>
      {!user && <Text style={styles.author}>Eta</Text>}
      {parts.map((part, index) => {
        if (part.type === "text")
          return user ? (
            <Text key={index} selectable style={styles.body}>
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
        if (part.type === "thinking")
          return (
            <View key={index}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showThinking }}
                onPress={() => setShowThinking(!showThinking)}
              >
                <Text style={styles.thinkingLabel}>
                  {showThinking ? "收起思考过程" : "查看思考过程"}
                </Text>
              </Pressable>
              {showThinking && (
                <Text selectable style={styles.thinking}>
                  {part.thinking}
                </Text>
              )}
            </View>
          );
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
        if (part.type === "image" && part.data && part.mimeType)
          return (
            <Image
              key={index}
              accessibilityLabel="消息中的图片"
              source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
              resizeMode="contain"
              style={styles.image}
            />
          );
        return (
          <Text key={index} style={styles.thinking}>
            [{part.type} 内容]
          </Text>
        );
      })}
      {message.errorMessage && (
        <Text selectable style={styles.error}>
          {message.errorMessage}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  message: { marginBottom: 26, gap: 6, alignSelf: "stretch" },
  user: {
    alignSelf: "flex-end",
    maxWidth: "92%",
    backgroundColor: colors.soft,
    borderRadius: 24,
    paddingHorizontal: 18,
    paddingVertical: 13,
  },
  author: { fontSize: 13, fontWeight: "600", color: colors.muted, marginBottom: 4 },
  body: { fontSize: 17, lineHeight: 26, color: colors.text },
  thinkingLabel: { fontSize: 13, color: colors.muted, paddingVertical: 8 },
  thinking: { color: colors.muted, lineHeight: 22, fontSize: 14 },
  tool: {
    backgroundColor: colors.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginVertical: 4,
  },
  toolHeader: { flexDirection: "row", alignItems: "center", gap: 8, padding: 13 },
  toolName: { flex: 1, color: colors.text, fontSize: 14 },
  toolState: { color: colors.muted, fontSize: 12 },
  details: { padding: 14, gap: 12, borderTopWidth: 1, borderTopColor: colors.border },
  code: { fontFamily: "monospace", fontSize: 12, lineHeight: 19, color: colors.text },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  image: { width: 240, height: 180, borderRadius: 14 },
});
const markdownStyles = StyleSheet.create({
  body: { color: colors.text, fontSize: 17, lineHeight: 27 },
  heading1: { fontSize: 25, fontWeight: "600", marginTop: 16, marginBottom: 8 },
  heading2: { fontSize: 22, fontWeight: "600", marginTop: 14, marginBottom: 8 },
  heading3: { fontSize: 19, fontWeight: "600", marginTop: 12, marginBottom: 6 },
  paragraph: { marginTop: 0, marginBottom: 10 },
  strong: { fontWeight: "600" },
  em: { fontStyle: "italic" },
  link: { color: colors.blue },
  blockquote: {
    backgroundColor: colors.soft,
    borderLeftWidth: 3,
    borderLeftColor: colors.border,
    padding: 12,
    marginVertical: 8,
  },
  code_inline: { backgroundColor: colors.soft, fontFamily: "monospace", fontSize: 14 },
  fence: {
    backgroundColor: colors.soft,
    borderRadius: 14,
    padding: 14,
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 8,
  },
  code_block: {
    backgroundColor: colors.soft,
    borderRadius: 14,
    padding: 14,
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 20,
  },
  bullet_list: { marginBottom: 10 },
  ordered_list: { marginBottom: 10 },
  list_item: { flexDirection: "row", justifyContent: "flex-start", marginVertical: 3 },
  bullet_list_icon: { marginRight: 8 },
  ordered_list_icon: { marginRight: 8 },
  bullet_list_content: { flex: 1 },
  ordered_list_content: { flex: 1 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, marginVertical: 8 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderColor: colors.border },
  th: { flex: 1, padding: 6, fontWeight: "600" },
  td: { flex: 1, padding: 6 },
  hr: { height: 1, backgroundColor: colors.border, marginVertical: 12 },
});
