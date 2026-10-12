import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ArrowUp, ChevronDown, Cpu, Shield, Square } from "lucide-react-native";
import { colors } from "../ui.tsx";

export interface ComposerInputProps {
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
  const showThinkingBadge = thinkingLevel && thinkingLevel !== "off" && thinkingLevelLabel;

  return (
    <View style={styles.container}>
      <TextInput
        accessibilityLabel="消息输入框"
        value={value}
        onChangeText={onChangeText}
        multiline
        placeholder={placeholder}
        placeholderTextColor="#959591"
        style={[styles.input, { height: inputHeight }]}
        onContentSizeChange={({ nativeEvent }) =>
          setInputHeight(Math.max(44, Math.min(140, nativeEvent.contentSize.height)))
        }
        editable={!disabled}
        textAlignVertical="top"
      />
      <View style={styles.toolbar}>
        <View style={styles.toolbarLeft}>
          {!!sandboxMode && !!sandboxModeLabel && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`当前沙盒策略：${sandboxModeLabel}，点击修改`}
              disabled={disabled || running}
              onPress={onOpenConfiguration}
              style={({ pressed }) => [styles.sandboxChip, pressed && styles.chipPressed]}
            >
              <Shield size={12} color={colors.muted} />
              <Text numberOfLines={1} style={styles.sandboxText}>
                {sandboxModeLabel}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.toolbarRight}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="选择模型与思考等级"
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

          {typeof contextTokens === "number" && contextTokens > 0 && (
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
              disabled={!canSend}
              onPress={onSubmit}
              style={({ pressed }) => [
                styles.actionButton,
                canSend ? styles.sendActive : styles.sendInactive,
                pressed && canSend && styles.buttonPressed,
              ]}
            >
              <ArrowUp size={18} strokeWidth={2.2} color={canSend ? "#FFFFFF" : "#A3A3A3"} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.05,
        shadowRadius: 10,
      },
      android: {
        elevation: 2,
      },
      default: {
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.05)",
      },
    }),
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
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
    marginTop: 4,
  },
  toolbarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  toolbarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  sandboxChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sandboxText: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "500",
  },
  modelButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 160,
  },
  modelText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: "500",
    flexShrink: 1,
  },
  thinkingBadge: {
    color: colors.muted,
    fontSize: 11,
  },
  tokensChip: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tokensText: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "500",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  chipPressed: {
    opacity: 0.7,
  },
  actionButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  sendActive: {
    backgroundColor: colors.text,
  },
  sendInactive: {
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
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
