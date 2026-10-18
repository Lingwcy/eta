import { useState } from "react";
import { useRouter } from "expo-router";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Power,
  RefreshCw,
  Trash2,
} from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobile } from "../provider.tsx";
import { colors, common, useAction } from "../ui.tsx";

function statusLabel(status: string) {
  if (status === "connected") return "已连接";
  if (status === "connecting" || status === "reconnecting") return "正在连接";
  return "连接不可用";
}

function statusColor(status: string) {
  if (status === "connected") return colors.success;
  if (status === "connecting" || status === "reconnecting") return "#D97706";
  return colors.danger;
}

/** Compact grouped row; keeps a full-height touch target without the pill weight. */
function ActionRow({
  icon: Icon,
  title,
  onPress,
  disabled,
  destructive = false,
}: {
  icon: LucideIcon;
  title: string;
  onPress: () => void;
  disabled: boolean;
  destructive?: boolean;
}) {
  const tint = destructive ? colors.danger : colors.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        pressed && styles.rowPressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon size={15} strokeWidth={1.9} color={tint} />
      <Text style={[styles.actionTitle, destructive && styles.destructive]}>{title}</Text>
      <ChevronRight size={14} color={colors.muted} />
    </Pressable>
  );
}

export function SettingsScreen({ onboarding = false }: { onboarding?: boolean }) {
  const { store, state } = useMobile();
  const router = useRouter();
  const [url, setUrl] = useState(state.url ?? "");
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const { busy, run } = useAction();
  const connect = () =>
    run(async () => {
      await store.connect({ url, token });
      setToken("");
      if (!onboarding && router.canGoBack()) router.back();
    });
  const clear = () =>
    Alert.alert(
      "清除连接和缓存？",
      "将清除手机上保存的连接、目录缓存、草稿和未确认消息的重试记录。Bot 上的会话与任务仍会保留。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "清除",
          style: "destructive",
          onPress: () => {
            void run(() => store.disconnect(true));
          },
        },
      ],
    );
  const blocked = busy || state.sending;
  const canConnect = !blocked && !!url.trim() && !!token.trim();
  return (
    <SafeAreaView style={common.screen}>
      <KeyboardAvoidingView
        style={common.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          {onboarding ? (
            <View style={styles.headerSpacer} />
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="返回会话"
              hitSlop={8}
              onPress={() => router.back()}
              style={({ pressed }) => [styles.back, pressed && styles.rowPressed]}
            >
              <ArrowLeft size={18} color={colors.text} />
            </Pressable>
          )}
          <Text numberOfLines={1} style={styles.headerTitle}>
            {onboarding ? "eta-mobile" : "连接设置"}
          </Text>
          <View style={styles.headerSpacer} />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Text style={styles.sectionLabel}>{onboarding ? "连接 Bot" : "Bot 连接"}</Text>
          <Text style={styles.intro}>
            手机连接已部署的 Eta Bot。项目、模型和任务都在 Bot 上运行。
          </Text>

          <View style={styles.group}>
            {state.url && (
              <>
                <View style={styles.statusRow}>
                  <View style={[styles.dot, { backgroundColor: statusColor(state.status) }]} />
                  <View style={styles.statusText}>
                    <Text style={styles.statusTitle}>{statusLabel(state.status)}</Text>
                    <Text numberOfLines={1} selectable style={styles.statusUrl}>
                      {state.url}
                    </Text>
                  </View>
                  {state.status === "connected" && <Check size={14} color={colors.success} />}
                </View>
                <View style={styles.divider} />
              </>
            )}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>服务器地址</Text>
              <TextInput
                accessibilityLabel="Bot 服务器地址"
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://bot.example.com"
                placeholderTextColor={colors.muted}
                style={styles.input}
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>访问令牌</Text>
              <View style={styles.tokenRow}>
                <TextInput
                  accessibilityLabel="Bot 访问令牌"
                  value={token}
                  onChangeText={setToken}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={!visible}
                  placeholder="输入 Bot 管理员令牌"
                  placeholderTextColor={colors.muted}
                  style={[styles.input, styles.tokenInput]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={visible ? "隐藏令牌" : "显示令牌"}
                  hitSlop={7}
                  onPress={() => setVisible(!visible)}
                  style={({ pressed }) => [styles.eye, pressed && styles.rowPressed]}
                >
                  {visible ? (
                    <EyeOff size={15} color={colors.muted} />
                  ) : (
                    <Eye size={15} color={colors.muted} />
                  )}
                </Pressable>
              </View>
            </View>
            {state.error && (
              <Text accessibilityRole="alert" style={styles.error}>
                {state.error}
              </Text>
            )}
            <View style={styles.divider} />
            <View style={styles.submitRow}>
              <Text style={styles.submitHint}>
                {busy ? "正在验证连接…" : "令牌只保存在这台手机"}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="验证并连接"
                hitSlop={6}
                disabled={!canConnect}
                onPress={() => {
                  void connect();
                }}
                style={({ pressed }) => [
                  styles.submit,
                  pressed && styles.submitPressed,
                  !canConnect && styles.submitDisabled,
                ]}
              >
                <Text style={[styles.submitText, !canConnect && styles.submitTextDisabled]}>
                  {busy ? "连接中" : "连接"}
                </Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.footnote}>
            令牌保存在手机的安全存储中；修改连接时需重新填写。正式部署建议使用 HTTPS。
          </Text>

          {state.url && (
            <>
              <Text style={[styles.sectionLabel, styles.sectionSpaced]}>连接操作</Text>
              <View style={styles.group}>
                <ActionRow
                  icon={RefreshCw}
                  title="重新连接"
                  disabled={blocked}
                  onPress={() => {
                    void run(() => store.reconnect());
                  }}
                />
                <View style={styles.divider} />
                <ActionRow
                  icon={Power}
                  title="断开连接"
                  disabled={blocked}
                  onPress={() => {
                    void run(() => store.disconnect());
                  }}
                />
                <View style={styles.divider} />
                <ActionRow
                  icon={Trash2}
                  title="清除连接和手机缓存"
                  disabled={blocked}
                  destructive
                  onPress={clear}
                />
              </View>
              <Text style={styles.footnote}>
                关闭 App 或断开连接后，Bot 已接收的任务会继续执行。需要取消任务时，请在会话中停止。
              </Text>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: {
    width: 32,
    height: 32,
    marginLeft: -6,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  headerSpacer: { width: 26 },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    color: colors.text,
    letterSpacing: -0.2,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 32,
    maxWidth: 560,
    width: "100%",
    alignSelf: "center",
  },
  sectionLabel: {
    paddingHorizontal: 2,
    fontSize: 11.5,
    fontWeight: "600",
    color: colors.muted,
    letterSpacing: 0.3,
  },
  sectionSpaced: { marginTop: 22 },
  intro: {
    marginTop: 4,
    marginBottom: 10,
    paddingHorizontal: 2,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.muted,
  },
  group: {
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.surface,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  statusText: { flex: 1, minWidth: 0 },
  statusTitle: { fontSize: 13, fontWeight: "600", color: colors.text },
  statusUrl: { marginTop: 1, fontSize: 11.5, color: colors.muted },
  field: { paddingHorizontal: 12, paddingVertical: 9 },
  fieldLabel: { marginBottom: 2, fontSize: 11.5, fontWeight: "500", color: colors.muted },
  input: {
    minHeight: 22,
    padding: 0,
    fontSize: 15,
    color: colors.text,
  },
  tokenRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  tokenInput: { flex: 1 },
  eye: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    fontSize: 12,
    lineHeight: 17,
    color: colors.danger,
  },
  submitRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  submitHint: { flex: 1, fontSize: 11.5, color: colors.muted },
  submit: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  submitPressed: { opacity: 0.82 },
  submitDisabled: {
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  submitText: { fontSize: 13, fontWeight: "600", color: colors.surface },
  submitTextDisabled: { color: colors.muted },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 12,
    backgroundColor: colors.borderSubtle,
  },
  actionRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  actionTitle: { flex: 1, fontSize: 14, color: colors.text },
  destructive: { color: colors.danger },
  rowPressed: { backgroundColor: colors.soft },
  disabled: { opacity: 0.45 },
  footnote: {
    marginTop: 8,
    paddingHorizontal: 2,
    fontSize: 11.5,
    lineHeight: 17,
    color: colors.muted,
  },
});
