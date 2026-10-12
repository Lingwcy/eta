import { Platform, StyleSheet, Text, View } from "react-native";
import type { BotSnapshot } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, ScrollArea, useAction } from "../ui.tsx";

export function Approvals({ snapshot }: { snapshot: BotSnapshot }) {
  const { state, store } = useMobile();
  const { busy, run } = useAction();
  return (
    <>
      {snapshot.approvals
        ?.filter((value) => value.status === "pending")
        .map((approval) => (
          <View key={approval.id} style={styles.card}>
            <Text style={styles.title}>需要审批 · {approval.tool}</Text>
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
