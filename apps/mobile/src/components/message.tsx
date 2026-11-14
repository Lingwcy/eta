import { Image, StyleSheet, Text, View } from "react-native";
import type { BotMessage, BotSnapshot } from "../bot/contracts.ts";
import { buildAssistantReplyView } from "../conversation.ts";
import type { ToolIndex } from "../conversation.ts";
import { FadeSlideIn } from "../motion.tsx";
import { radii } from "../theme.ts";
import { useI18n } from "../i18n/index.ts";
import { colors } from "../ui.tsx";
import { ThrottledMarkdown } from "./markdown.tsx";
import { ReplyArea } from "./reply-area.tsx";
import { ToolCard } from "./tool-card.tsx";

export { ToolCard } from "./tool-card.tsx";

function UserMessageView({ message }: { message: BotMessage }) {
  const { m } = useI18n();
  const parts =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  const images = parts.filter(
    (part): part is { type: "image"; data: string; mimeType: string } =>
      part.type === "image" && Boolean(part.data) && Boolean(part.mimeType),
  );
  const texts = parts.filter((part) => part.type === "text" && part.text);
  const others = parts.filter(
    (part) => part.type !== "text" && !(part.type === "image" && part.data && part.mimeType),
  );

  return (
    <FadeSlideIn offset={5} duration={160} style={styles.userContainer}>
      {images.length > 0 && (
        <View style={styles.userImages}>
          {images.map((part, index) => (
            <Image
              key={index}
              accessibilityLabel={m.message.userImageAlt}
              source={{ uri: `data:${part.mimeType};base64,${part.data}` }}
              resizeMode="cover"
              style={styles.userImage}
            />
          ))}
        </View>
      )}
      {(texts.length > 0 || others.length > 0) && (
        <View style={styles.userBubble}>
          {texts.map((part, index) => (
            <Text key={`t-${index}`} selectable style={styles.userText}>
              {part.text}
            </Text>
          ))}
          {others.map((part, index) => (
            <Text key={`o-${index}`} style={styles.fallbackContent}>
              {m.message.fallbackContent(part.type)}
            </Text>
          ))}
        </View>
      )}
    </FadeSlideIn>
  );
}

export function MessageView({
  message,
  messages,
  snapshot,
  tools,
}: {
  message?: BotMessage;
  messages?: readonly BotMessage[];
  snapshot: BotSnapshot;
  tools: ToolIndex;
}) {
  const list = messages && messages.length > 0 ? messages : message ? [message] : [];
  if (list.length === 0) return null;

  const first = list[0]!;
  if (first.role === "user") {
    return <UserMessageView message={first} />;
  }
  if (first.role === "toolResult") {
    return null;
  }

  const view = buildAssistantReplyView(list, snapshot, tools);
  const { m } = useI18n();

  if (
    view.steps.length === 0 &&
    !view.answer &&
    view.errors.length === 0 &&
    view.images.length === 0
  ) {
    return null;
  }

  return (
    <View style={styles.assistantTurn}>
      <ReplyArea view={view} />
      {view.images.length > 0 && (
        <View style={styles.assistantImages}>
          {view.images.map((image, index) => (
            <Image
              key={index}
              accessibilityLabel={m.message.assistantImageAlt}
              source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
              resizeMode="contain"
              style={styles.assistantImage}
            />
          ))}
        </View>
      )}
      {view.answer !== null && (
        <View style={styles.answerBody}>
          <ThrottledMarkdown content={view.answer} streaming={view.streaming} />
        </View>
      )}
      {view.errors.map((err, index) => (
        <Text key={index} selectable style={styles.errorText}>
          {err}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  userContainer: {
    alignItems: "flex-end",
    marginBottom: 18,
    gap: 8,
  },
  userImages: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
    maxWidth: "85%",
  },
  userImage: {
    width: 210,
    height: 150,
    borderRadius: 16,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  userBubble: {
    maxWidth: "84%",
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.lg,
    borderBottomRightRadius: 6,
    paddingHorizontal: 15,
    paddingVertical: 10,
    gap: 6,
  },
  userText: {
    fontSize: 15.5,
    lineHeight: 23,
    color: colors.text,
  },
  assistantTurn: {
    marginBottom: 20,
    paddingVertical: 2,
  },
  assistantImages: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  assistantImage: {
    width: 220,
    height: 160,
    borderRadius: radii.md,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  answerBody: {
    marginTop: 2,
  },
  fallbackContent: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.tertiary,
  },
  errorText: {
    marginTop: 6,
    color: colors.danger,
    fontSize: 13.5,
    lineHeight: 20,
  },
});

export type { ToolCard as ToolCardComponent };
