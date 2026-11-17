import { Pressable, StyleSheet, Text, View } from "react-native";
import { AlertTriangle, CloudOff, RefreshCw, SlidersHorizontal } from "lucide-react-native";
import type { ReactNode } from "react";
import type { BotSnapshot } from "../bot/contracts.ts";
import { useI18n } from "../i18n/index.ts";
import { colors } from "../ui.tsx";

/** Muted grey designed for the white canvas (#FFFFFF). */
const mutedOnCanvas = "#71717A";
/** colors.danger on dangerSoft stays high-contrast. */
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
  running: colors.ink ?? colors.text,
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
  const { m } = useI18n();
  return (
    <View role="alert" style={styles.banner}>
      <AlertTriangle size={16} color={toneColors.warning} />
      <View style={styles.bannerText}>
        <Text style={styles.bannerTitle}>
          {reconnecting ? m.status.reconnectingBot : m.status.botUnavailable}
        </Text>
        <Text numberOfLines={1} style={styles.bannerDetail}>
          {message || url || m.status.checkNetworkFallback}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={m.status.reconnectLabel}
        hitSlop={6}
        disabled={busy}
        onPress={onReconnect}
        style={({ pressed }) => [
          styles.bannerAction,
          pressed && styles.pressed,
          busy && styles.disabled,
        ]}
      >
        <Text style={styles.bannerActionText}>{m.status.reconnectAction}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={m.status.openSettingsLabel}
        hitSlop={6}
        onPress={onSettings}
        style={({ pressed }) => [styles.bannerGhost, pressed && styles.pressed]}
      >
        <SlidersHorizontal size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

/** Single line error strip for a connected Bot that reported a failure. */
export function ErrorStrip({ message }: { message: string }) {
  return (
    <View role="alert" style={styles.error}>
      <AlertTriangle size={16} color={colors.danger} />
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
  const { m } = useI18n();
  return (
    <View style={styles.pending}>
      <CloudOff size={16} color={colors.muted} />
      <View style={styles.pendingText}>
        <Text style={styles.pendingTitle}>
          {sending ? m.status.submittingPending : m.status.unconfirmedPending}
        </Text>
        <Text numberOfLines={1} style={styles.pendingDetail}>
          {[prompt, imageCount ? m.status.imageCount(imageCount) : ""].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {!sending && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={m.status.retryLabel}
          hitSlop={6}
          disabled={!connected || busy}
          onPress={onRetry}
          style={({ pressed }) => [
            styles.pendingAction,
            pressed && styles.pressed,
            (!connected || busy) && styles.disabled,
          ]}
        >
          <RefreshCw size={14} color={colors.text} />
          <Text style={styles.pendingActionText}>{m.common.retry}</Text>
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
    paddingHorizontal: 24,
    paddingBottom: 32,
  },
  emptyTitle: {
    maxWidth: 320,
    textAlign: "center",
    fontSize: 21,
    lineHeight: 30,
    fontWeight: "500",
    color: colors.text,
    letterSpacing: -0.2,
  },
  emptyHint: {
    maxWidth: 320,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 21,
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
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  errorText: { flex: 1, fontSize: 14, lineHeight: 17, color: errorTextColor },
  pending: {
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
