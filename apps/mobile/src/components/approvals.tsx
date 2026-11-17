import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import { Bot, ChevronRight, ShieldQuestion } from "lucide-react-native";
import type { BotSnapshot } from "../bot/contracts.ts";
import { getMessages, useI18n } from "../i18n/index.ts";
import { FadeSlideIn } from "../motion.tsx";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, ScrollArea, useAction } from "../ui.tsx";

type Approval = NonNullable<BotSnapshot["approvals"]>[number];

type Reuse = "call" | "run";

/** Mirrors the desktop card: what automatic review said about a request still waiting for the user. */
function reviewNote(approval: Approval) {
  const review = approval.review;
  if (!review) return undefined;
  const { approvals } = getMessages();
  if (review.status === "reviewing")
    return review.toolCalls?.length
      ? approvals.reviewingWithCount(review.toolCalls.length)
      : approvals.reviewing;
  if (review.status === "escalated")
    return approvals.escalated(review.risk === "high", review.rationale ?? "");
  if (review.status === "skipped" && review.skippedReason)
    return approvals.skipped[review.skippedReason];
  return undefined;
}

function historyLabel(approval: Approval) {
  const { approvals } = getMessages();
  if (approval.decidedBy === "reuse") return approvals.reuseApproved;
  return approval.status === "denied" ? approvals.autoDenied : approvals.autoApproved;
}

function accessSummary(approval: Approval) {
  const { approvals } = getMessages();
  const sep = approvals.listSeparator;
  if (approval.writableRoots.length) return approvals.writeScope(approval.writableRoots.join(sep));
  if (approval.readableRoots.length) return approvals.readScope(approval.readableRoots.join(sep));
  if (approval.gitMetadata)
    return approvals.gitScope(approval.gitMetadata.branch ?? approval.gitMetadata.commonDir);
  return undefined;
}

function ApprovalDetails({
  approval,
  includeArguments = false,
}: {
  approval: Approval;
  includeArguments?: boolean;
}) {
  const { m } = useI18n();
  const sep = m.approvals.listSeparator;
  return (
    <View style={styles.details}>
      {approval.review?.rationale && (
        <Text selectable style={styles.detailText}>
          {m.approvals.rationalePrefix}
          {approval.review.rationale}
        </Text>
      )}
      {approval.gitMetadata && (
        <Text selectable style={styles.detailText}>
          {m.approvals.gitMetadataPrefix}
          {approval.gitMetadata.branch
            ? m.approvals.gitBranchPrefix(approval.gitMetadata.branch)
            : ""}
          {m.approvals.gitRepoPrefix(approval.gitMetadata.commonDir)}
        </Text>
      )}
      {!!approval.readableRoots.length && (
        <Text selectable style={styles.detailText}>
          {m.approvals.readablePathsPrefix}
          {approval.readableRoots.join(sep)}
        </Text>
      )}
      {!!approval.writableRoots.length && (
        <Text selectable style={styles.detailText}>
          {m.approvals.writablePathsPrefix}
          {approval.writableRoots.join(sep)}
        </Text>
      )}
      {approval.networkAccess && (
        <Text style={styles.detailText}>{m.approvals.networkRequest}</Text>
      )}
      {approval.review?.reviewer && (
        <Text style={styles.detailText}>
          {m.approvals.reviewerModelPrefix(
            approval.review.reviewer.provider,
            approval.review.reviewer.modelId,
          )}
        </Text>
      )}
      {!!approval.review?.toolCalls?.length && (
        <Text selectable style={styles.detailText}>
          {m.approvals.reviewerCheckedPrefix(
            approval.review.toolCalls.map((call) => call.summary).join(sep),
          )}
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
  const { m } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const note = reviewNote(approval);
  const summary = accessSummary(approval);
  const target = approval.gitMetadata ? m.approvals.gitWriteTarget : approval.tool;
  return (
    <FadeSlideIn offset={6} duration={170} style={styles.card}>
      <View style={styles.headingRow}>
        <ShieldQuestion size={15} strokeWidth={1.8} color={colors.muted} />
        <Text numberOfLines={1} style={styles.title}>
          {m.approvals.approvalHeading(target)}
        </Text>
        {approval.networkAccess && (
          <Text style={styles.networkBadge}>{m.approvals.networkBadge}</Text>
        )}
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
        <Text style={styles.disclosureText}>
          {detailsOpen ? m.approvals.collapseDetails : m.approvals.expandDetails}
        </Text>
      </Pressable>
      {detailsOpen && (
        <FadeSlideIn offset={4} duration={150}>
          <ApprovalDetails approval={approval} includeArguments />
        </FadeSlideIn>
      )}
      <View style={common.row}>
        <View style={styles.action}>
          <Button
            secondary
            disabled={busy || !connected}
            onPress={() => onDecision(approval.id, false)}
          >
            {m.approvals.deny}
          </Button>
        </View>
        <View style={styles.action}>
          <Button disabled={busy || !connected} onPress={() => onDecision(approval.id, true)}>
            {m.approvals.approveOnce}
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
            {m.approvals.allowForRun}
          </Button>
          <Text style={styles.reuseHint}>{m.approvals.reuseHint}</Text>
        </>
      )}
    </FadeSlideIn>
  );
}

export function Approvals({ snapshot }: { snapshot: BotSnapshot }) {
  const { state, store } = useMobile();
  const { m } = useI18n();
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
            <Text style={styles.historyTitle}>{m.approvals.historyTitle(history.length)}</Text>
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
                        {historyLabel(approval)}
                        {m.approvals.historySeparator}
                        {approval.gitMetadata ? m.approvals.gitWriteTarget : approval.tool}
                        {approval.review?.rationale
                          ? `${m.approvals.historySeparator}${approval.review.rationale}`
                          : ""}
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
    borderRadius: 16,
    padding: 14,
    gap: 8,
    marginBottom: 10,
  },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: "600", color: colors.text },
  networkBadge: {
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 5,
    backgroundColor: colors.soft,
    color: colors.muted,
    fontSize: 11,
  },
  note: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  reason: { color: colors.text, fontSize: 14, lineHeight: 20 },
  scopeSummary: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  disclosure: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 2,
  },
  disclosureIcon: { transform: [{ rotate: "0deg" }] },
  disclosureIconOpen: { transform: [{ rotate: "90deg" }] },
  disclosureText: { color: colors.muted, fontSize: 13 },
  details: {
    gap: 6,
    padding: 9,
    borderRadius: 9,
    backgroundColor: colors.soft,
  },
  detailText: { color: colors.muted, fontSize: 12, lineHeight: 17 },
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
  historyTitle: { flex: 1, color: colors.muted, fontSize: 13 },
  historyList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
  historyItem: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  historyRow: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5 },
  historyRowText: { flex: 1, minWidth: 0, color: colors.muted, fontSize: 12 },
});
