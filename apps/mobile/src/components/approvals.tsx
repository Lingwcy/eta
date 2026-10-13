import { Platform, StyleSheet, Text, View } from "react-native";
import type { BotSnapshot } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, ScrollArea, useAction } from "../ui.tsx";

type Approval = NonNullable<BotSnapshot["approvals"]>[number];

const skipped: Record<string, string> = {
  "requires-user": "此范围只能由你批准",
  "reviewer-unavailable": "审查模型不可用，已转交给你",
  timeout: "自动审查超时，已转交给你",
  "invalid-output": "审查结果无法解析，已转交给你",
  "circuit-breaker": "连续被自动拒绝，已转交给你",
  "tool-budget": "审查超出工具调用上限，已转交给你",
  interrupted: "审查被中断，已转交给你",
};

/** Mirrors the desktop card: what automatic review said about a request still waiting for the user. */
function reviewNote(approval: Approval) {
  const review = approval.review;
  if (!review) return undefined;
  if (review.status === "reviewing") return "自动审查中";
  if (review.status === "escalated")
    return `自动审查建议你确认${review.risk === "high" ? "（高风险）" : ""}：${review.rationale ?? ""}`;
  if (review.status === "skipped" && review.skippedReason) return skipped[review.skippedReason];
  return undefined;
}

export function Approvals({ snapshot }: { snapshot: BotSnapshot }) {
  const { state, store } = useMobile();
  const { busy, run } = useAction();
  return (
    <>
      {snapshot.approvals
        ?.filter((value) => value.status === "pending")
        .map((approval) => (
          <View key={approval.id} style={styles.card}>
            <Text style={styles.title}>
              需要审批 · {approval.gitMetadata ? "Git 写入" : approval.tool}
            </Text>
            {reviewNote(approval) && <Text style={common.hint}>{reviewNote(approval)}</Text>}
            <Text selectable style={common.body}>
              {approval.reason}
            </Text>
            <ScrollArea maxHeight={140} style={styles.codeScroll}>
              <Text selectable style={styles.code}>
                {JSON.stringify(approval.args, null, 2)}
              </Text>
            </ScrollArea>
            {approval.networkAccess && <Text style={common.hint}>请求网络访问</Text>}
            {!!approval.readableRoots.length && (
              <Text selectable style={common.hint}>
                可读路径：{approval.readableRoots.join("、")}
              </Text>
            )}
            {!!approval.writableRoots.length && (
              <Text selectable style={common.hint}>
                可写路径：{approval.writableRoots.join("、")}
              </Text>
            )}
            <View style={common.row}>
              <View style={styles.action}>
                <Button
                  secondary
                  disabled={busy || state.status !== "connected"}
                  onPress={() => {
                    void run(() => store.approve(approval.id, false));
                  }}
                >
                  拒绝
                </Button>
              </View>
              <View style={styles.action}>
                <Button
                  disabled={busy || state.status !== "connected"}
                  onPress={() => {
                    void run(() => store.approve(approval.id, true));
                  }}
                >
                  批准
                </Button>
              </View>
            </View>
            {approval.reusable && (
              <Button
                secondary
                disabled={busy || state.status !== "connected"}
                onPress={() => {
                  void run(() => store.approve(approval.id, true, "run"));
                }}
              >
                本次运行内允许此 Git 范围
              </Button>
            )}
          </View>
        ))}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    marginBottom: 14,
  },
  title: { fontSize: 15, fontWeight: "600", color: colors.text },
  codeScroll: {
    backgroundColor: colors.soft,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  code: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: colors.text,
  },
  action: { flex: 1 },
});
