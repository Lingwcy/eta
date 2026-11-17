import { useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import { radii } from "../theme.ts";
import { colors } from "../ui.tsx";

const MARKDOWN_RENDER_THROTTLE_MS = 100;

/** Throttle markdown re-parses during active token streaming. */
export function useThrottleMarkdownRender(content: string, enable: boolean): string {
  const [output, setOutput] = useState(content);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (!enable) {
      setOutput(content);
      return;
    }
    const now = Date.now();
    const delay = MARKDOWN_RENDER_THROTTLE_MS - (now - lastUpdateRef.current);
    const update = () => {
      lastUpdateRef.current = Date.now();
      setOutput(content);
    };
    if (delay <= 0) {
      update();
      return;
    }
    const timer = setTimeout(update, delay);
    return () => clearTimeout(timer);
  }, [content, enable]);

  return enable ? output : content;
}

export function ThrottledMarkdown({
  content,
  streaming,
  thinking = false,
}: {
  content: string;
  streaming: boolean;
  thinking?: boolean;
}) {
  const throttled = useThrottleMarkdownRender(content, streaming);
  return (
    <Markdown
      style={thinking ? thinkingMarkdownStyles : markdownStyles}
      mergeStyle={false}
      rules={thinking ? thinkingMarkdownRules : markdownRules}
      onLinkPress={(url) => {
        if (/^https?:\/\//i.test(url)) void Linking.openURL(url).catch(() => {});
        return false;
      }}
    >
      {throttled}
    </Markdown>
  );
}

function renderCodeBlock(key: string, content: string, lang?: string, compact = false) {
  let code = content;
  if (code.endsWith("\n")) code = code.slice(0, -1);
  return (
    <View key={key} style={[styles.codeBlock, compact && styles.codeBlockCompact]}>
      <View style={styles.codeBlockBanner}>
        <Text style={styles.codeBlockLang}>{lang?.trim() || "code"}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={[styles.codeBlockText, compact && styles.codeBlockTextCompact]}>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

const markdownRules: RenderRules = {
  fence: (node) => {
    const sourceInfo = (node as { sourceInfo?: string }).sourceInfo;
    return renderCodeBlock(node.key, node.content, sourceInfo, false);
  },
  code_block: (node) => renderCodeBlock(node.key, node.content, undefined, false),
};

const thinkingMarkdownRules: RenderRules = {
  fence: (node) => {
    const sourceInfo = (node as { sourceInfo?: string }).sourceInfo;
    return renderCodeBlock(node.key, node.content, sourceInfo, true);
  },
  code_block: (node) => renderCodeBlock(node.key, node.content, undefined, true),
};

const monoFont = Platform.OS === "ios" ? "Menlo" : "monospace";

const markdownStyles = StyleSheet.create({
  body: {
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 24,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 10,
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 24,
  },
  heading1: {
    color: colors.text,
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "600",
    marginTop: 14,
    marginBottom: 8,
  },
  heading2: {
    color: colors.text,
    fontSize: 17.5,
    lineHeight: 25,
    fontWeight: "600",
    marginTop: 12,
    marginBottom: 6,
  },
  heading3: {
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 22,
    fontWeight: "600",
    marginTop: 10,
    marginBottom: 4,
  },
  strong: { fontWeight: "600", color: colors.text },
  em: { fontStyle: "italic", color: colors.text },
  link: {
    color: colors.ink,
    textDecorationLine: "underline",
  },
  blockquote: {
    backgroundColor: colors.surfaceSubtle,
    borderLeftWidth: 3,
    borderLeftColor: colors.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 8,
    borderRadius: 4,
  },
  code_inline: {
    backgroundColor: colors.softCode,
    color: colors.text,
    borderRadius: radii.xs,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontSize: 13,
    fontFamily: monoFont,
  },
  code_block: {
    backgroundColor: colors.codeBg,
    color: colors.text,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 8,
    fontFamily: monoFont,
  },
  fence: {
    backgroundColor: colors.codeBg,
    color: colors.text,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    fontSize: 13,
    lineHeight: 20,
    marginVertical: 8,
    fontFamily: monoFont,
  },
  bullet_list: { marginBottom: 10 },
  ordered_list: { marginBottom: 10 },
  list_item: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 4,
  },
  bullet_list_content: { flex: 1 },
  ordered_list_content: { flex: 1 },
  bullet_list_icon: {
    color: colors.tertiary,
    fontSize: 15,
    lineHeight: 24,
    marginRight: 8,
  },
  ordered_list_icon: {
    color: colors.secondary,
    fontSize: 14,
    lineHeight: 24,
    fontWeight: "500",
    marginRight: 8,
  },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    overflow: "hidden",
    marginVertical: 10,
  },
  th: {
    padding: 8,
    backgroundColor: colors.codeHeader,
    borderBottomWidth: 1,
    borderColor: colors.border,
    fontWeight: "600",
    color: colors.text,
    fontSize: 13,
  },
  td: {
    padding: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 13,
  },
  hr: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
});

const thinkingMarkdownStyles = StyleSheet.create({
  body: {
    color: colors.secondary,
    fontSize: 13.5,
    lineHeight: 20.5,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 6,
    color: colors.secondary,
    fontSize: 13.5,
    lineHeight: 20.5,
  },
  heading1: {
    color: colors.secondary,
    fontSize: 15,
    lineHeight: 21,
    fontWeight: "600",
    marginTop: 8,
    marginBottom: 4,
  },
  heading2: {
    color: colors.secondary,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    marginTop: 8,
    marginBottom: 4,
  },
  heading3: {
    color: colors.secondary,
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: "600",
    marginTop: 6,
    marginBottom: 3,
  },
  strong: { fontWeight: "600", color: colors.text },
  em: { fontStyle: "italic", color: colors.secondary },
  link: {
    color: colors.text,
    textDecorationLine: "underline",
  },
  blockquote: {
    backgroundColor: colors.soft,
    borderLeftWidth: 2,
    borderLeftColor: colors.dimmed,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginVertical: 6,
  },
  code_inline: {
    backgroundColor: colors.softCode,
    color: colors.text,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 0.5,
    fontSize: 12,
    fontFamily: monoFont,
  },
  bullet_list: { marginBottom: 6 },
  ordered_list: { marginBottom: 6 },
  list_item: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 3,
  },
  bullet_list_content: { flex: 1 },
  ordered_list_content: { flex: 1 },
  bullet_list_icon: {
    color: colors.tertiary,
    fontSize: 13,
    lineHeight: 20.5,
    marginRight: 6,
  },
  ordered_list_icon: {
    color: colors.tertiary,
    fontSize: 12.5,
    lineHeight: 20.5,
    marginRight: 6,
  },
  hr: {
    backgroundColor: colors.borderSubtle,
    height: StyleSheet.hairlineWidth,
    marginVertical: 8,
  },
});

const styles = StyleSheet.create({
  codeBlock: {
    marginVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.codeBg,
    overflow: "hidden",
  },
  codeBlockCompact: {
    marginVertical: 6,
    borderRadius: radii.sm,
  },
  codeBlockBanner: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.codeHeader,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  codeBlockLang: {
    fontSize: 11.5,
    fontWeight: "500",
    color: colors.secondary,
    fontFamily: monoFont,
  },
  codeBlockText: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.text,
    fontFamily: monoFont,
  },
  codeBlockTextCompact: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    lineHeight: 17,
  },
});
