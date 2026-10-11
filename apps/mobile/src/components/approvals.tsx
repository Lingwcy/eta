import { StyleSheet, Text, View } from "react-native";
import type { BotSnapshot } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, useAction } from "../ui.tsx";

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
            <Text selectable style={styles.code}>
              {JSON.stringify(approval.args, null, 2)}
            </Text>
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
    borderRadius: 22,
    padding: 18,
    gap: 12,
    marginBottom: 18,
  },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  code: { fontSize: 12, lineHeight: 18, fontFamily: "monospace", color: colors.muted },
  action: { flex: 1 },
});
