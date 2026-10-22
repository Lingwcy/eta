import { useState } from "react";
import {
  Image,
  ScrollView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { ArrowUp, ChevronDown, Cpu, ImagePlus, Shield, Square, X } from "lucide-react-native";
import { colors } from "../ui.tsx";
import type { DraftImage } from "../bot/store.ts";

/** Chip labels sit on the soft grey chip background; muted drops them to 4.35:1 there. */
const chipText = "#525252";

export interface ComposerInputProps {
  images?: readonly DraftImage[];
  onAddImages?: () => void;
  onRemoveImage?: (id: string) => void;
  pickingImages?: boolean;
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onOpenConfiguration: () => void;
  running: boolean;
  canSend: boolean;
  canStop: boolean;
  disabled?: boolean;
  modelName?: string;
  thinkingLevel?: string;
  thinkingLevelLabel?: string;
  sandboxMode?: string;
  sandboxModeLabel?: string;
  contextTokens?: number;
  placeholder?: string;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

export function ComposerInput({
  images = [],
  onAddImages,
  onRemoveImage,
  pickingImages = false,
  value,
  onChangeText,
  onSubmit,
  onStop,
  onOpenConfiguration,
  running,
  canSend,
  canStop,
  disabled = false,
  modelName,
  thinkingLevel,
  thinkingLevelLabel,
  sandboxMode,
  sandboxModeLabel,
  contextTokens,
  placeholder = "交给 Eta Bot…",
}: ComposerInputProps) {
  const [inputHeight, setInputHeight] = useState(44);
  const { width } = useWindowDimensions();
  /** Small phones cannot fit the sandbox label and token count beside the model picker. */
  const compactToolbar = width < 360;
  const showThinkingBadge = thinkingLevel && thinkingLevel !== "off" && thinkingLevelLabel;

  return (
    <View style={styles.container}>
      {!!images.length && (
        <ScrollView horizontal contentContainerStyle={styles.attachments}>
          {images.map((image, index) => (
            <View key={image.id} style={styles.attachment}>
              <Image
                accessibilityLabel={image.name ?? "图片 " + (index + 1)}
                source={{ uri: "data:" + image.mimeType + ";base64," + image.data }}
                style={styles.preview}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={"移除图片 " + (index + 1)}
                disabled={disabled}
                onPress={() => onRemoveImage?.(image.id)}
                style={styles.removeImage}
                hitSlop={6}
              >
                <X size={14} color={colors.text} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
      <TextInput
        accessibilityLabel="消息输入框"
        value={value}
        onChangeText={onChangeText}
        multiline
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, { height: inputHeight }]}
        onContentSizeChange={({ nativeEvent }) =>
          setInputHeight(Math.max(44, Math.min(140, nativeEvent.contentSize.height)))
        }
        editable={!disabled}
        textAlignVertical="top"
      />
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          {onAddImages && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pickingImages ? "正在读取图片" : "添加图片"}
              disabled={disabled || pickingImages || images.length >= 4}
              onPress={onAddImages}
              hitSlop={6}
              style={({ pressed }) => [
                styles.imageButton,
                pressed && styles.chipPressed,
                (disabled || pickingImages || images.length >= 4) && styles.buttonDisabled,
              ]}
            >
              <ImagePlus size={18} color={colors.muted} />
            </Pressable>
          )}
          {!!sandboxMode && !!sandboxModeLabel && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`当前沙盒策略：${sandboxModeLabel}，点击修改`}
              hitSlop={6}
              disabled={disabled || running}
              onPress={onOpenConfiguration}
              style={({ pressed }) => [styles.sandboxChip, pressed && styles.chipPressed]}
            >
              <Shield size={12} color={colors.muted} />
              {!compactToolbar && (
                <Text numberOfLines={1} style={styles.sandboxText}>
                  {sandboxModeLabel}
                </Text>
              )}
            </Pressable>
          )}
        </View>

        <View style={styles.toolbarRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="选择模型与思考等级"
            hitSlop={6}
            disabled={disabled || running}
            onPress={onOpenConfiguration}
            style={({ pressed }) => [styles.modelButton, pressed && styles.chipPressed]}
          >
            <Cpu size={13} color={colors.muted} />
            <Text numberOfLines={1} style={styles.modelText}>
              {modelName ?? "选择模型"}
            </Text>
            {showThinkingBadge && <Text style={styles.thinkingBadge}>{thinkingLevelLabel}</Text>}
            <ChevronDown size={13} color={colors.muted} />
          </Pressable>

          {!compactToolbar && typeof contextTokens === "number" && contextTokens > 0 && (
            <View
              accessibilityLabel={`已用 token: ${formatTokens(contextTokens)}`}
              style={styles.tokensChip}
            >
              <Text style={styles.tokensText}>{formatTokens(contextTokens)}</Text>
            </View>
          )}

          {running ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="停止任务"
              hitSlop={2}
              disabled={!canStop}
              onPress={onStop}
              style={({ pressed }) => [
                styles.actionButton,
                styles.stopButton,
                pressed && styles.buttonPressed,
                !canStop && styles.buttonDisabled,
              ]}
            >
              <Square size={13} color="#FFFFFF" fill="#FFFFFF" />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送消息"
              hitSlop={2}
              disabled={!canSend}
              onPress={onSubmit}
              style={({ pressed }) => [
                styles.actionButton,
                canSend ? styles.sendActive : styles.sendInactive,
                pressed && canSend && styles.buttonPressed,
              ]}
            >
              <ArrowUp size={18} strokeWidth={2.2} color={canSend ? "#FFFFFF" : colors.muted} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  attachments: { gap: 10, paddingVertical: 6, paddingHorizontal: 6 },
  attachment: { width: 64, height: 64 },
  preview: { width: 64, height: 64, borderRadius: 10 },
  removeImage: {
    position: "absolute",
    top: -4,
    right: -4,
    borderRadius: 12,
    width: 24,
    height: 24,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  imageButton: { width: 28, minHeight: 32, alignItems: "center", justifyContent: "center" },
  container: {
    backgroundColor: "#F4F4F4",
    borderRadius: 24,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
  },
  input: {
    minHeight: 44,
    maxHeight: 140,
    fontSize: 16,
    lineHeight: 24,
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 6,
    color: colors.text,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingTop: 6,
  },
  toolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  toolbarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
    minWidth: 0,
  },
  sandboxChip: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  sandboxText: {
    color: chipText,
    fontSize: 12,
    fontWeight: "500",
  },
  modelButton: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: colors.surface,
    maxWidth: 160,
    flexShrink: 1,
    minWidth: 0,
  },
  modelText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "500",
    flexShrink: 1,
  },
  thinkingBadge: {
    color: chipText,
    fontSize: 12,
  },
  tokensChip: {
    flexShrink: 0,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  tokensText: {
    color: chipText,
    fontSize: 12,
    fontWeight: "500",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  chipPressed: {
    opacity: 0.7,
  },
  actionButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sendActive: {
    backgroundColor: colors.text,
  },
  sendInactive: {
    backgroundColor: "#E7E7E7",
  },
  stopButton: {
    backgroundColor: colors.text,
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
});
