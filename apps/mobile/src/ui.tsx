import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Modal,
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

export const colors = {
  background: "#F9F9F8",
  surface: "#FFFFFF",
  text: "#171717",
  muted: "#737373",
  border: "#E5E5E5",
  borderSubtle: "#EEEEED",
  blue: "#2563EB",
  blueSoft: "#EFF6FF",
  soft: "#F5F5F4",
  softHover: "#EAEAE8",
  danger: "#DC2626",
  dangerSoft: "#FEE2E2",
  success: "#16A34A",
  successSoft: "#DCFCE7",
};

export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  primary = false,
  size = 20,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.icon,
        primary && styles.primary,
        (pressed || disabled) && styles.dim,
      ]}
    >
      <Icon size={size} strokeWidth={2} color={primary ? colors.surface : colors.text} />
    </Pressable>
  );
}

export function Button({
  children,
  onPress,
  disabled = false,
  secondary = false,
  destructive = false,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondary,
        destructive && styles.destructive,
        (pressed || disabled) && styles.dim,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText]}>{children}</Text>
    </Pressable>
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
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          accessibilityLabel="关闭面板"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <SheetContent title={title} onClose={onClose}>
          {children}
        </SheetContent>
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
  return (
    <View
      accessibilityViewIsModal
      style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}
    >
      <View style={styles.sheetHandle} />
      <View style={styles.sheetHeader}>
        <Text style={styles.heading}>{title}</Text>
        <IconButton icon={X} label="关闭" size={18} onPress={onClose} />
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
      Alert.alert("操作未完成", error instanceof Error ? error.message : "请重试");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, run };
}

export const common = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  heading: { fontSize: 24, fontWeight: "600", color: colors.text, letterSpacing: -0.3 },
  label: { fontSize: 13, fontWeight: "500", color: colors.muted, marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 23, color: colors.text },
  hint: { fontSize: 13, lineHeight: 20, color: colors.muted },
  field: {
    backgroundColor: colors.surface,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
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
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  primary: { backgroundColor: colors.text, borderColor: colors.text },
  dim: { opacity: 0.45 },
  button: {
    minHeight: 44,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  secondary: {
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  destructive: { backgroundColor: colors.danger },
  buttonText: { color: colors.surface, fontSize: 15, fontWeight: "600" },
  secondaryText: { color: colors.text },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "#00000040" },
  sheet: {
    maxHeight: "85%",
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D4D4D4",
    alignSelf: "center",
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  sheetContent: { paddingHorizontal: 20, paddingBottom: 16, gap: 12 },
  heading: { fontSize: 18, fontWeight: "600", color: colors.text },
});
