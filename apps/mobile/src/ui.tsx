import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Animated,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getMessages, useI18n } from "./i18n/index.ts";
import { SpringPressable } from "./motion.tsx";
import { colors, radii } from "./theme.ts";

export { colors, radii } from "./theme.ts";

export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  primary = false,
  ghost = false,
  size = 20,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  ghost?: boolean;
  size?: number;
}) {
  return (
    <SpringPressable
      scaleTo={0.93}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.icon,
        ghost && styles.iconGhost,
        primary && styles.primary,
        ghost && pressed && !disabled && styles.iconGhostPressed,
        !ghost && pressed && !disabled && styles.pressedSoft,
        disabled && styles.dim,
      ]}
    >
      <Icon size={size} strokeWidth={1.9} color={primary ? colors.surface : colors.text} />
    </SpringPressable>
  );
}

export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  destructive = false,
  compact = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
  /** Inline size for footer chips and empty states; the default stays a full touch target. */
  compact?: boolean;
}) {
  return (
    <SpringPressable
      scaleTo={0.97}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={compact ? 5 : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        secondary && styles.secondary,
        destructive && styles.destructive,
        pressed && !disabled && styles.buttonPressed,
        disabled && styles.dim,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          compact && styles.compactText,
          secondary && styles.secondaryText,
        ]}
      >
        {children}
      </Text>
    </SpringPressable>
  );
}

export function ScrollArea({
  children,
  style,
  contentContainerStyle,
  maxHeight = 220,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: StyleProp<ViewStyle>;
  maxHeight?: number;
}) {
  return (
    <ScrollView
      style={[{ maxHeight }, style]}
      contentContainerStyle={contentContainerStyle}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
    >
      {children}
    </ScrollView>
  );
}

export function Sheet({
  title,
  visible,
  onClose,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const slideAnim = useRef(new Animated.Value(280)).current;
  const backdropAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    slideAnim.setValue?.(280);
    backdropAnim.setValue?.(0);
    Animated.parallel?.([
      Animated.timing(backdropAnim, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 250,
        friction: 26,
        useNativeDriver: true,
      }),
    ]).start?.();
  }, [backdropAnim, slideAnim, visible]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlayWrap}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.overlayBackdrop, { opacity: backdropAnim }]}
        >
          <Pressable
            accessibilityLabel={getMessages().common.closePanel}
            onPress={onClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View style={{ transform: [{ translateY: slideAnim }] }}>
          <SheetContent title={title} onClose={onClose}>
            {children}
          </SheetContent>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function SheetContent({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { m } = useI18n();
  return (
    <View
      accessibilityViewIsModal
      style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}
    >
      <View style={styles.sheetHandle} />
      <View style={styles.sheetHeader}>
        <Text style={styles.heading}>{title}</Text>
        <IconButton ghost icon={X} label={m.common.close} size={18} onPress={onClose} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
        {children}
      </ScrollView>
    </View>
  );
}

/** Prevent a second tap from repeating a remote control operation while its response is pending. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = async (action: () => void | Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      const { common } = getMessages();
      Alert.alert(
        common.actionFailedTitle,
        error instanceof Error ? error.message : common.actionFailedFallback,
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

export const common = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  heading: { fontSize: 22, fontWeight: "600", color: colors.text, letterSpacing: -0.3 },
  label: { fontSize: 13, fontWeight: "500", color: colors.muted, marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
  hint: { fontSize: 13, lineHeight: 20, color: colors.muted },
  field: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  section: { gap: 10, marginBottom: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
});

const styles = StyleSheet.create({
  icon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  iconGhost: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  iconGhostPressed: {
    backgroundColor: colors.interactiveHover,
  },
  pressedSoft: {
    backgroundColor: colors.soft,
  },
  primary: { backgroundColor: colors.ink, borderColor: colors.ink },
  dim: { opacity: 0.35 },
  button: {
    minHeight: 42,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 21,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  compact: {
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
  },
  compactText: { fontSize: 13 },
  secondary: {
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  destructive: { backgroundColor: colors.danger },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: colors.surface, fontSize: 14, fontWeight: "600" },
  secondaryText: { color: colors.text },
  overlayWrap: { flex: 1, justifyContent: "flex-end" },
  overlayBackdrop: {
    backgroundColor: colors.overlay,
  },
  sheet: {
    maxHeight: "85%",
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sheetHandle: {
    width: 34,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.dimmed,
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  sheetContent: { paddingHorizontal: 20, paddingBottom: 16, gap: 12 },
  heading: { fontSize: 17, fontWeight: "600", color: colors.text, letterSpacing: -0.2 },
});
