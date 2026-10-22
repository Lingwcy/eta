import { Pressable, StyleSheet, Text, View } from "react-native";
import { AlertTriangle, CloudOff, RefreshCw, SlidersHorizontal } from "lucide-react-native";
import type { ReactNode } from "react";
import type { BotSnapshot } from "../bot/contracts.ts";
import { colors } from "../ui.tsx";

/** Muted grey designed for the app canvas (#f9f9f8), where colors.muted drops to 4.48:1. */
const mutedOnCanvas = "#525252";
/** colors.danger on dangerSoft is 3.95:1; this stays above 4.5:1. */
const errorTextColor = "#B91C1C";

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

/** First paint for an empty conversation; matches the Desktop welcome instead of bare text. */
export function ChatEmptyState({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyHint}>{hint}</Text>
      {children}
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
  imageCount = 0,
  busy,
  connected,
  onRetry,
}: {
  sending: boolean;
  prompt: string;
  imageCount?: number;
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
          {[prompt, imageCount ? `${imageCount} 张图片` : ""].filter(Boolean).join(" · ")}
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
  empty: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    paddingBottom: 56,
  },
  emptyTitle: {
    maxWidth: 320,
    textAlign: "center",
    fontSize: 26,
    lineHeight: 34,
    fontWeight: "600",
    color: colors.text,
    letterSpacing: -0.4,
  },
  emptyHint: {
    maxWidth: 330,
    textAlign: "center",
    fontSize: 15,
    lineHeight: 22,
    color: mutedOnCanvas,
  },
  task: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
    marginBottom: 10,
  },
  taskDot: { width: 6, height: 6, borderRadius: 3 },
  taskText: { flex: 1, fontSize: 14, lineHeight: 17, color: mutedOnCanvas },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bannerText: { flex: 1, minWidth: 0 },
  bannerTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  bannerDetail: { marginTop: 1, fontSize: 13, color: colors.muted },
  bannerAction: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: "#FCD34D",
    alignItems: "center",
    justifyContent: "center",
  },
  bannerActionText: { fontSize: 13, fontWeight: "600", color: colors.text },
  bannerGhost: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  errorText: { flex: 1, fontSize: 14, lineHeight: 17, color: errorTextColor },
  pending: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pendingText: { flex: 1, minWidth: 0 },
  pendingTitle: { fontSize: 14, fontWeight: "600", color: colors.text },
  pendingDetail: { marginTop: 1, fontSize: 13, color: colors.muted },
  pendingAction: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pendingActionText: { fontSize: 13, fontWeight: "500", color: colors.text },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },
});
