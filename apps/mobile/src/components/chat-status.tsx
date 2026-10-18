import { Pressable, StyleSheet, Text, View } from "react-native";
import { AlertTriangle, CloudOff, RefreshCw, SlidersHorizontal } from "lucide-react-native";
import type { BotSnapshot } from "../bot/contracts.ts";
import { colors } from "../ui.tsx";

export type TaskTone = "running" | "warning" | "danger" | "done" | "idle";

/** One tone per task state so the status line reads at a glance. */
export function taskTone(snapshot?: BotSnapshot): TaskTone {
  if (!snapshot) return "idle";
  if (snapshot.blockedReason || snapshot.faulted) return "danger";
  if (snapshot.recoveryRequired) return "warning";
  const operation = snapshot.operation;
  if (operation) {
    if (operation.status === "aborting") return "warning";
    if (
      operation.waitingForApproval ||
      operation.waitingForSubagents ||
      operation.retry ||
      operation.deferred
    )
      return "warning";
    return "running";
  }
  if (snapshot.compacting) return "warning";
  if (snapshot.lastResult?.status === "failed") return "danger";
  if (snapshot.lastResult?.status === "aborted") return "warning";
  if (snapshot.lastResult?.status === "completed") return "done";
  return "idle";
}

const toneColors: Record<TaskTone, string> = {
  running: colors.blue,
  warning: "#D97706",
  danger: colors.danger,
  done: colors.success,
  idle: colors.muted,
};

/** Compact single-line task state shown under the transcript. */
export function TaskStatus({ label, tone }: { label: string; tone: TaskTone }) {
  return (
    <View role="status" style={styles.task}>
      <View style={[styles.taskDot, { backgroundColor: toneColors[tone] }]} />
      <Text numberOfLines={1} style={styles.taskText}>
        {label}
      </Text>
    </View>
  );
}

/** Compact connection strip; replaces the link-heavy card when the Bot is unreachable. */
export function ConnectionBanner({
  reconnecting,
  message,
  url,
  busy,
  onReconnect,
  onSettings,
}: {
  reconnecting: boolean;
  message?: string;
  url?: string;
  busy: boolean;
  onReconnect: () => void;
  onSettings: () => void;
}) {
  return (
    <View role="alert" style={styles.banner}>
      <AlertTriangle size={15} color={toneColors.warning} />
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>{reconnecting ? "正在重连 Bot" : "Bot 连接不可用"}</Text>
        <Text numberOfLines={1} style={styles.bannerDetail}>
          {message || url || "检查手机网络或 Bot 服务"}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重新连接 Bot"
        hitSlop={6}
        disabled={busy}
        onPress={onReconnect}
        style={({ pressed }) => [
          styles.bannerAction,
          pressed && styles.pressed,
          busy && styles.disabled,
        ]}
      >
        <Text style={styles.bannerActionText}>重连</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="打开连接设置"
        hitSlop={6}
        onPress={onSettings}
        style={({ pressed }) => [styles.bannerGhost, pressed && styles.pressed]}
      >
        <SlidersHorizontal size={14} color={colors.muted} />
      </Pressable>
    </View>
  );
}

/** Single line error strip for a connected Bot that reported a failure. */
export function ErrorStrip({ message }: { message: string }) {
  return (
    <View role="alert" style={styles.error}>
      <AlertTriangle size={14} color={colors.danger} />
      <Text numberOfLines={2} style={styles.errorText}>
        {message}
      </Text>
    </View>
  );
}

/** Unconfirmed send: keep the pending prompt and retry next to one compact row. */
export function PendingNotice({
  sending,
  prompt,
  busy,
  connected,
  onRetry,
}: {
  sending: boolean;
  prompt: string;
  busy: boolean;
  connected: boolean;
  onRetry: () => void;
}) {
  return (
    <View style={styles.pending}>
      <CloudOff size={15} color={colors.muted} />
      <View style={styles.pendingText}>
        <Text style={styles.pendingTitle}>
          {sending ? "正在提交消息…" : "上次消息的接收状态待确认"}
        </Text>
        <Text numberOfLines={1} style={styles.pendingDetail}>
          {prompt}
        </Text>
      </View>
      {!sending && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重试并确认接收"
          hitSlop={6}
          disabled={!connected || busy}
          onPress={onRetry}
          style={({ pressed }) => [
            styles.pendingAction,
            pressed && styles.pressed,
            (!connected || busy) && styles.disabled,
          ]}
        >
          <RefreshCw size={12} color={colors.text} />
          <Text style={styles.pendingActionText}>重试</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    marginBottom: 10,
  },
  taskDot: { width: 6, height: 6, borderRadius: 3 },
  taskText: { flex: 1, fontSize: 12.5, lineHeight: 17, color: colors.muted },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bannerText: { flex: 1, minWidth: 0 },
  bannerTitle: { fontSize: 12.5, fontWeight: "600", color: colors.text },
  bannerDetail: { marginTop: 1, fontSize: 11.5, color: colors.muted },
  bannerAction: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 7,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#FCD34D",
    alignItems: "center",
    justifyContent: "center",
  },
  bannerActionText: { fontSize: 12, fontWeight: "600", color: colors.text },
  bannerGhost: {
    width: 28,
    height: 28,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: { flex: 1, fontSize: 12.5, lineHeight: 17, color: colors.danger },
  pending: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pendingText: { flex: 1, minWidth: 0 },
  pendingTitle: { fontSize: 12.5, fontWeight: "600", color: colors.text },
  pendingDetail: { marginTop: 1, fontSize: 11.5, color: colors.muted },
  pendingAction: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 9,
    borderRadius: 7,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pendingActionText: { fontSize: 12, fontWeight: "500", color: colors.text },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
});
