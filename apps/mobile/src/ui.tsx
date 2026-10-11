import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export const colors = {
  background: "#F8F8F7",
  surface: "#FFFFFF",
  text: "#191919",
  muted: "#777875",
  border: "#E8E8E5",
  blue: "#2463EB",
  soft: "#EFEEEB",
  danger: "#B53B36",
};

export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  primary = false,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.icon,
        primary && styles.primary,
        (pressed || disabled) && styles.dim,
      ]}
    >
      <Icon size={23} strokeWidth={1.9} color={primary ? colors.surface : colors.text} />
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
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
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
      <View style={styles.sheetHeader}>
        <Text style={styles.heading}>{title}</Text>
        <IconButton icon={X} label="关闭" onPress={onClose} />
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
  heading: { fontSize: 25, fontWeight: "600", color: colors.text },
  label: { fontSize: 14, color: colors.muted, marginBottom: 8 },
  body: { fontSize: 16, lineHeight: 24, color: colors.text },
  hint: { fontSize: 14, lineHeight: 22, color: colors.muted },
  field: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 16,
    fontSize: 16,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  section: { gap: 12, marginBottom: 24 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
});
const styles = StyleSheet.create({
  icon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  primary: { backgroundColor: colors.blue },
  dim: { opacity: 0.45 },
  button: {
    minHeight: 48,
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 24,
    backgroundColor: colors.blue,
    alignItems: "center",
    justifyContent: "center",
  },
  secondary: { backgroundColor: colors.soft },
  destructive: { backgroundColor: colors.danger },
  buttonText: { color: colors.surface, fontSize: 16, fontWeight: "600" },
  secondaryText: { color: colors.text },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "#00000035" },
  sheet: {
    maxHeight: "85%",
    backgroundColor: colors.background,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
  },
  sheetContent: { paddingHorizontal: 24, paddingBottom: 16, gap: 14 },
  heading: { fontSize: 21, fontWeight: "600", color: colors.text },
});
