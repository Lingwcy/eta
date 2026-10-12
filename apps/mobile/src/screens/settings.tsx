import { useState } from "react";
import { useRouter } from "expo-router";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ArrowLeft, Check, Eye, EyeOff } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, IconButton, useAction } from "../ui.tsx";

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
  return (
    <SafeAreaView style={common.screen}>
      <KeyboardAvoidingView
        style={common.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          {!onboarding && (
            <IconButton icon={ArrowLeft} label="返回会话" onPress={() => router.back()} />
          )}
          <Text style={styles.brand}>{onboarding ? "eta-mobile" : "Bot 连接"}</Text>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <View style={common.section}>
            <Text style={common.heading}>{onboarding ? "连接 Bot，继续工作" : "连接设置"}</Text>
            <Text style={common.hint}>
              手机连接已部署的 Eta Bot。项目、模型和任务都在 Bot 上运行。
            </Text>
          </View>
          {state.url && (
            <View style={styles.status}>
              {state.status === "connected" && <Check size={18} color={colors.blue} />}
              <View style={styles.statusText}>
                <Text style={common.body}>
                  {state.status === "connected"
                    ? "已连接"
                    : state.status === "connecting" || state.status === "reconnecting"
                      ? "正在连接"
                      : "连接不可用"}
                </Text>
                <Text selectable style={common.hint}>
                  {state.url}
                </Text>
              </View>
            </View>
          )}
          <View style={common.section}>
            <View>
              <Text style={common.label}>服务器地址</Text>
              <TextInput
                accessibilityLabel="Bot 服务器地址"
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://bot.example.com"
                placeholderTextColor={colors.muted}
                style={common.field}
              />
            </View>
            <View>
              <Text style={common.label}>访问令牌</Text>
              <View style={styles.token}>
                <TextInput
                  accessibilityLabel="Bot 访问令牌"
                  value={token}
                  onChangeText={setToken}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry={!visible}
                  placeholder="输入 Bot 管理员令牌"
                  placeholderTextColor={colors.muted}
                  style={styles.tokenInput}
                />
                <IconButton
                  icon={visible ? EyeOff : Eye}
                  label={visible ? "隐藏令牌" : "显示令牌"}
                  onPress={() => setVisible(!visible)}
                />
              </View>
            </View>
            <Text style={common.hint}>
              访问令牌保存在手机的安全存储中。修改连接时需重新填写令牌。正式部署建议使用 HTTPS。
            </Text>
            {state.error && (
              <Text accessibilityRole="alert" style={common.error}>
                {state.error}
              </Text>
            )}
            <Button
              onPress={() => {
                void connect();
              }}
              disabled={busy || state.sending || !url.trim() || !token.trim()}
            >
              {busy ? "正在验证连接…" : "验证并连接"}
            </Button>
          </View>
          {state.url && (
            <View style={common.section}>
              <Button
                secondary
                disabled={busy || state.sending}
                onPress={() => {
                  void run(() => store.reconnect());
                }}
              >
                重新连接
              </Button>
              <Button
                secondary
                disabled={busy || state.sending}
                onPress={() => {
                  void run(() => store.disconnect());
                }}
              >
                断开连接
              </Button>
            </View>
          )}
          <View style={common.section}>
            <Text style={common.hint}>
              关闭 App 或断开连接后，Bot 已接收的任务会继续执行。需要取消任务时，请在会话中停止。
            </Text>
            <Button secondary disabled={busy || state.sending} onPress={clear}>
              清除连接和手机缓存
            </Button>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  brand: { fontSize: 18, fontWeight: "600", color: colors.text },
  content: { padding: 24, paddingTop: 40, maxWidth: 560, width: "100%", alignSelf: "center" },
  status: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 20,
  },
  statusText: { flex: 1 },
  token: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingRight: 6,
  },
  tokenInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
    color: colors.text,
  },
});
