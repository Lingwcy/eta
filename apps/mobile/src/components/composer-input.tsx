import { useState } from "react";
import { Image, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  ArrowUp,
  ChevronDown,
  Lock,
  Plus,
  Shield,
  ShieldCheck,
  Square,
  X,
} from "lucide-react-native";
import type { BotSnapshot, Configuration } from "../bot/contracts.ts";
import type { DraftImage } from "../bot/store.ts";
import { SpringPressable } from "../motion.tsx";
import { useI18n } from "../i18n/index.ts";
import { colors } from "../ui.tsx";
import { ProviderMark } from "./provider-mark.tsx";

export interface ComposerInputProps {
  images?: readonly DraftImage[];
  onAddImages?: () => void;
  onRemoveImage?: (id: string) => void;
  pickingImages?: boolean;
  value: string;
  onChangeText: (value: string) => void;
  onSubmit: () => void;
  allowSubmitWhileRunning?: boolean;
  onStop: () => void;
  onOpenConfiguration: () => void;
  onToggleSandbox?: () => void;
  running: boolean;
  canSend: boolean;
  canStop: boolean;
  disabled?: boolean;
  modelName?: string;
  modelProvider?: string;
  thinkingLevel?: Configuration["thinkingLevel"];
  thinkingLevelLabel?: string;
  sandboxMode?: NonNullable<BotSnapshot["sandbox"]>["mode"];
  sandboxModeLabel?: string;
  contextTokens?: number;
  placeholder?: string;
}

function PermissionIcon({ mode }: { mode?: NonNullable<BotSnapshot["sandbox"]>["mode"] }) {
  if (mode === "read-only") {
    return <Lock size={15} strokeWidth={1.9} color={colors.tertiary} />;
  }
  if (mode === "workspace-write") {
    return <Shield size={16} strokeWidth={1.9} color={colors.secondary} />;
  }
  return <ShieldCheck size={16} strokeWidth={2} color={colors.ink} />;
}

export function ComposerInput({
  images = [],
  onAddImages,
  onRemoveImage,
  pickingImages = false,
  value,
  onChangeText,
  onSubmit,
  allowSubmitWhileRunning = false,
  onStop,
  onOpenConfiguration,
  onToggleSandbox,
  running,
  canSend,
  canStop,
  disabled = false,
  modelName,
  modelProvider,
  sandboxMode = "danger-full-access",
  sandboxModeLabel,
  placeholder,
}: ComposerInputProps) {
  const { m } = useI18n();
  const resolvedSandboxLabel =
    sandboxModeLabel ?? m.configuration.sandboxModes["danger-full-access"];
  const resolvedPlaceholder = placeholder ?? m.composer.defaultPlaceholder;
  const [inputHeight, setInputHeight] = useState(36);
  const showStop = running && (!allowSubmitWhileRunning || (!value.trim() && !images.length));
  const expanded = value.length > 0 || images.length > 0 || inputHeight > 42;

  return (
    <View style={styles.wrapper}>
      {!!images.length && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.attachments}
        >
          {images.map((image, index) => (
            <View key={image.id} style={styles.attachment}>
              <Image
                accessibilityLabel={image.name ?? m.composer.imageItemLabel(index)}
                source={{ uri: "data:" + image.mimeType + ";base64," + image.data }}
                style={styles.preview}
              />
              <SpringPressable
                scaleTo={0.9}
                accessibilityRole="button"
                accessibilityLabel={m.composer.removeImageLabel(index)}
                disabled={disabled}
                onPress={() => onRemoveImage?.(image.id)}
                containerStyle={styles.removeImageWrap}
                style={styles.removeImage}
                hitSlop={6}
              >
                <X size={11} strokeWidth={2.5} color={colors.surface} />
              </SpringPressable>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.inputHost}>
        {/* Keep TextInput at a stable node position so expanding from 1-row pill to full-width never dismisses the keyboard. */}
        <TextInput
          accessibilityLabel={m.composer.inputLabel}
          value={value}
          onChangeText={onChangeText}
          multiline
          placeholder={resolvedPlaceholder}
          placeholderTextColor={colors.caption}
          selectionColor={colors.ink}
          style={[
            styles.textarea,
            expanded ? styles.textareaExpanded : styles.textareaCompact,
            { height: Math.max(expanded ? 40 : 36, inputHeight) },
          ]}
          onContentSizeChange={({ nativeEvent }) =>
            setInputHeight(Math.max(36, Math.min(132, nativeEvent.contentSize.height)))
          }
          editable={!disabled}
          textAlignVertical={expanded ? "top" : "center"}
        />

        <View pointerEvents="box-none" style={styles.controlsOverlay}>
          <View style={styles.left}>
            {onAddImages && (
              <SpringPressable
                scaleTo={0.92}
                accessibilityRole="button"
                accessibilityLabel={
                  pickingImages ? m.composer.readingImagesLabel : m.composer.addImageLabel
                }
                disabled={disabled || pickingImages || images.length >= 4}
                onPress={onAddImages}
                hitSlop={4}
                style={({ pressed }) => [
                  styles.plusButton,
                  pressed && styles.plusButtonPressed,
                  (disabled || pickingImages || images.length >= 4) && styles.disabled,
                ]}
              >
                <Plus size={18} strokeWidth={2} color={colors.text} />
              </SpringPressable>
            )}
          </View>

          <View style={styles.right}>
            <SpringPressable
              accessibilityRole="button"
              accessibilityLabel={m.composer.modelAndThinkingLabel}
              hitSlop={4}
              disabled={disabled || running}
              onPress={onOpenConfiguration}
              style={({ pressed }) => [
                styles.modelTrigger,
                pressed && !disabled && !running && styles.modelTriggerPressed,
                (disabled || running) && styles.disabled,
              ]}
            >
              {modelProvider ? (
                <ProviderMark id={modelProvider} size={13} color={colors.secondary} />
              ) : null}
              <Text numberOfLines={1} ellipsizeMode="tail" style={styles.modelLabel}>
                {modelName ?? m.composer.selectModel}
              </Text>
              <ChevronDown size={13} strokeWidth={2} color={colors.tertiary} />
            </SpringPressable>

            <SpringPressable
              scaleTo={0.92}
              accessibilityRole="button"
              accessibilityLabel={m.composer.permissionLabel(resolvedSandboxLabel)}
              hitSlop={4}
              disabled={disabled || running}
              onPress={onToggleSandbox ?? onOpenConfiguration}
              onLongPress={onOpenConfiguration}
              style={({ pressed }) => [
                styles.permissionButton,
                pressed && !disabled && !running && styles.permissionButtonPressed,
                (disabled || running) && styles.disabled,
              ]}
            >
              <PermissionIcon mode={sandboxMode} />
            </SpringPressable>

            {showStop ? (
              <SpringPressable
                scaleTo={0.91}
                accessibilityRole="button"
                accessibilityLabel={m.composer.stopTaskLabel}
                hitSlop={4}
                disabled={!canStop}
                onPress={onStop}
                style={({ pressed }) => [
                  styles.sendButton,
                  pressed && canStop && styles.sendButtonPressed,
                  !canStop && styles.sendDisabled,
                ]}
              >
                <Square size={11} color={colors.surface} fill={colors.surface} />
              </SpringPressable>
            ) : (
              <SpringPressable
                scaleTo={0.91}
                accessibilityRole="button"
                accessibilityLabel={running ? m.composer.followUpLabel : m.composer.sendLabel}
                hitSlop={4}
                disabled={!canSend}
                onPress={onSubmit}
                style={({ pressed }) => [
                  styles.sendButton,
                  pressed && canSend && styles.sendButtonPressed,
                  !canSend && styles.sendDisabled,
                ]}
              >
                <ArrowUp size={17} strokeWidth={2.2} color={colors.surface} />
              </SpringPressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    backgroundColor: colors.surface,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "#E8E8EC",
    padding: 7,
  },
  attachments: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 5,
    paddingTop: 5,
    paddingBottom: 6,
  },
  attachment: {
    position: "relative",
    width: 60,
    height: 60,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.soft,
    overflow: "hidden",
  },
  preview: {
    width: "100%",
    height: "100%",
  },
  removeImageWrap: {
    position: "absolute",
    top: 4,
    right: 4,
  },
  removeImage: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "rgba(9, 9, 11, 0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
  inputHost: {
    position: "relative",
    minHeight: 36,
    justifyContent: "center",
  },
  textarea: {
    width: "100%",
    maxHeight: 132,
    fontSize: 15.5,
    lineHeight: 21,
    color: colors.text,
  },
  textareaCompact: {
    minHeight: 36,
    paddingLeft: 44,
    paddingRight: 204,
    paddingTop: 7,
    paddingBottom: 7,
  },
  textareaExpanded: {
    minHeight: 40,
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 4,
    marginBottom: 42,
  },
  controlsOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
  },
  plusButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  plusButtonPressed: {
    backgroundColor: colors.softHover,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
  },
  modelTrigger: {
    height: 34,
    maxWidth: 128,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 5,
    borderRadius: 14,
  },
  modelTriggerPressed: {
    backgroundColor: colors.soft,
  },
  modelLabel: {
    fontSize: 12.5,
    lineHeight: 17,
    fontWeight: "500",
    color: colors.secondary,
    flexShrink: 1,
  },
  permissionButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#E8E8EC",
    alignItems: "center",
    justifyContent: "center",
  },
  permissionButtonPressed: {
    backgroundColor: colors.soft,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonPressed: {
    backgroundColor: colors.inkSoft,
  },
  sendDisabled: {
    backgroundColor: "#D4D4D8",
  },
  disabled: {
    opacity: 0.4,
  },
});
