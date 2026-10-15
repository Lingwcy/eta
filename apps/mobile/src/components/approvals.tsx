import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import { Bot, ChevronRight, ShieldQuestion } from "lucide-react-native";
import type { BotSnapshot } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, ScrollArea, useAction } from "../ui.tsx";

type Approval = NonNullable<BotSnapshot["approvals"]>[number];

type Reuse = "call" | "run";

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
  if (review.status === "reviewing")
    return review.toolCalls?.length
      ? `自动审查中（已查看 ${review.toolCalls.length} 项）`
      : "自动审查中";
  if (review.status === "escalated")
    return `自动审查建议你确认${review.risk === "high" ? "（高风险）" : ""}：${review.rationale ?? ""}`;
  if (review.status === "skipped" && review.skippedReason) return skipped[review.skippedReason];
  return undefined;
}

function historyLabel(approval: Approval) {
  if (approval.decidedBy === "reuse") return "沿用本次运行的批准";
  return approval.status === "denied" ? "已自动拒绝" : "已自动批准";
}

function accessSummary(approval: Approval) {
  if (approval.writableRoots.length) return `写入范围：${approval.writableRoots.join("、")}`;
  if (approval.readableRoots.length) return `可读路径：${approval.readableRoots.join("、")}`;
  if (approval.gitMetadata)
    return `Git 范围：${approval.gitMetadata.branch ?? approval.gitMetadata.commonDir}`;
  return undefined;
}

function ApprovalDetails({
  approval,
  includeArguments = false,
}: {
  approval: Approval;
  includeArguments?: boolean;
}) {
  return (
    <View style={styles.details}>
      {approval.review?.rationale && (
        <Text selectable style={styles.detailText}>
          审查意见：{approval.review.rationale}
        </Text>
      )}
      {approval.gitMetadata && (
        <Text selectable style={styles.detailText}>
          Git 元数据：{approval.gitMetadata.branch ? `分支 ${approval.gitMetadata.branch}，` : ""}
          仓库 {approval.gitMetadata.commonDir}
        </Text>
      )}
      {!!approval.readableRoots.length && (
        <Text selectable style={styles.detailText}>
          可读路径：{approval.readableRoots.join("、")}
        </Text>
      )}
      {!!approval.writableRoots.length && (
        <Text selectable style={styles.detailText}>
          可写路径：{approval.writableRoots.join("、")}
        </Text>
      )}
      {approval.networkAccess && <Text style={styles.detailText}>请求网络访问</Text>}
      {approval.review?.reviewer && (
        <Text style={styles.detailText}>
          审查模型：{approval.review.reviewer.provider}/{approval.review.reviewer.modelId}
        </Text>
      )}
      {!!approval.review?.toolCalls?.length && (
        <Text selectable style={styles.detailText}>
          审查器查看了：{approval.review.toolCalls.map((call) => call.summary).join("、")}
        </Text>
      )}
      {includeArguments && (
        <ScrollArea maxHeight={140} style={styles.codeScroll}>
          <Text selectable style={styles.code}>
            {JSON.stringify(approval.args, null, 2)}
          </Text>
        </ScrollArea>
      )}
    </View>
  );
}

function PendingApproval({
  approval,
  busy,
  connected,
  onDecision,
}: {
  approval: Approval;
  busy: boolean;
  connected: boolean;
  onDecision: (id: string, approved: boolean, reuse?: Reuse) => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const note = reviewNote(approval);
  const summary = accessSummary(approval);
  return (
    <View style={styles.card}>
      <View style={styles.headingRow}>
        <ShieldQuestion size={15} strokeWidth={1.8} color={colors.muted} />
        <Text numberOfLines={1} style={styles.title}>
          需要审批 · {approval.gitMetadata ? "Git 写入" : approval.tool}
        </Text>
        {approval.networkAccess && <Text style={styles.networkBadge}>联网</Text>}
      </View>
      {note && (
        <Text numberOfLines={2} style={styles.note}>
          {note}
        </Text>
      )}
      <Text selectable style={styles.reason}>
        {approval.reason}
      </Text>
      {summary && (
        <Text numberOfLines={1} style={styles.scopeSummary}>
          {summary}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: detailsOpen }}
        onPress={() => setDetailsOpen((open) => !open)}
        style={styles.disclosure}
      >
        <ChevronRight
          size={14}
          color={colors.muted}
          style={[styles.disclosureIcon, detailsOpen && styles.disclosureIconOpen]}
        />
        <Text style={styles.disclosureText}>{detailsOpen ? "收起权限详情" : "权限详情与参数"}</Text>
      </Pressable>
      {detailsOpen && <ApprovalDetails approval={approval} includeArguments />}
      <View style={common.row}>
        <View style={styles.action}>
          <Button
            secondary
            disabled={busy || !connected}
            onPress={() => onDecision(approval.id, false)}
          >
            拒绝
          </Button>
        </View>
        <View style={styles.action}>
          <Button disabled={busy || !connected} onPress={() => onDecision(approval.id, true)}>
            批准一次
          </Button>
        </View>
      </View>
      {approval.reusable && (
        <>
          <Button
            secondary
            disabled={busy || !connected}
            onPress={() => onDecision(approval.id, true, "run")}
          >
            本次运行内允许此 Git 范围
          </Button>
          <Text style={styles.reuseHint}>
            同范围的命令都可写入这些 Git 目录，包括共享对象库；不含 config 与 hooks。
          </Text>
        </>
      )}
    </View>
  );
}

export function Approvals({ snapshot }: { snapshot: BotSnapshot }) {
  const { state, store } = useMobile();
  const { busy, run } = useAction();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState<string>();
  const history = snapshot.operation
    ? (snapshot.approvalHistory ?? []).slice(-20).toReversed()
    : [];
  const decide = (id: string, approved: boolean, reuse?: Reuse) => {
    void run(() => store.approve(id, approved, reuse));
  };
  return (
    <>
      {snapshot.approvals
        ?.filter((value) => value.status === "pending")
        .map((approval) => (
          <PendingApproval
            key={approval.id}
            approval={approval}
            busy={busy}
            connected={state.status === "connected"}
            onDecision={decide}
          />
        ))}
      {history.length > 0 && (
        <View style={[styles.card, styles.historyCard]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: historyOpen }}
            onPress={() => {
              setHistoryOpen((open) => !open);
              setExpandedHistory(undefined);
            }}
            style={styles.historyHeader}
          >
            <Bot size={14} color={colors.muted} />
            <Text style={styles.historyTitle}>自动审查记录（{history.length}）</Text>
            <ChevronRight
              size={14}
              color={colors.muted}
              style={[styles.disclosureIcon, historyOpen && styles.disclosureIconOpen]}
            />
          </Pressable>
          {historyOpen && (
            <View style={styles.historyList}>
              {history.map((approval) => {
                const expanded = expandedHistory === approval.id;
                return (
                  <View key={approval.id} style={styles.historyItem}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      onPress={() => setExpandedHistory(expanded ? undefined : approval.id)}
                      style={styles.historyRow}
                    >
                      <ChevronRight
                        size={13}
                        color={colors.muted}
                        style={[styles.disclosureIcon, expanded && styles.disclosureIconOpen]}
                      />
                      <Text numberOfLines={1} style={styles.historyRowText}>
                        {historyLabel(approval)} ·{" "}
                        {approval.gitMetadata ? "Git 写入" : approval.tool}
                        {approval.review?.rationale ? ` · ${approval.review.rationale}` : ""}
                      </Text>
                    </Pressable>
                    {expanded && <ApprovalDetails approval={approval} />}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 12,
    gap: 8,
    marginBottom: 10,
  },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { flex: 1, minWidth: 0, fontSize: 14, fontWeight: "600", color: colors.text },
  networkBadge: {
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: colors.soft,
    color: colors.muted,
    fontSize: 10,
  },
  note: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  reason: { color: colors.text, fontSize: 13, lineHeight: 19 },
  scopeSummary: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  disclosure: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 2,
  },
  disclosureIcon: { transform: [{ rotate: "0deg" }] },
  disclosureIconOpen: { transform: [{ rotate: "90deg" }] },
  disclosureText: { color: colors.muted, fontSize: 12 },
  details: {
    gap: 6,
    padding: 9,
    borderRadius: 9,
    backgroundColor: colors.soft,
  },
  detailText: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  codeScroll: {
    maxHeight: 140,
    backgroundColor: colors.surface,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: 8,
  },
  code: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: colors.text,
  },
  action: { flex: 1 },
  reuseHint: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  historyCard: { paddingVertical: 4, gap: 0 },
  historyHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  historyTitle: { flex: 1, color: colors.muted, fontSize: 12 },
  historyList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  historyItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  historyRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5 },
  historyRowText: { flex: 1, minWidth: 0, color: colors.muted, fontSize: 11 },
});
