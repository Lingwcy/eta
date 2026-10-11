import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import type { Configuration } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, Sheet, useAction } from "../ui.tsx";

export const thinkingLabels = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};
export const sandboxLabels = {
  "read-only": "只读",
  "workspace-write": "工作区沙盒",
  "danger-full-access": "完全访问",
};

export function ConfigurationSheet({
  configuration,
  onClose,
}: {
  configuration: Configuration;
  onClose: () => void;
}) {
  const { state, store } = useMobile();
  const [selected, setSelected] = useState(configuration);
  const { busy, run } = useAction();
  const model = state.library?.models.find(
    (value) => value.id === selected.modelId && value.provider === selected.provider,
  );
  const modes =
    state.thread?.snapshot.sandbox?.allowedModes ?? state.library?.allowedSandboxModes ?? [];
  return (
    <Sheet visible title="模型与执行设置" onClose={onClose}>
      <Text style={common.label}>模型</Text>
      {state.library?.models.map((value) => (
        <Pressable
          key={`${value.provider}:${value.id}`}
          accessibilityRole="radio"
          accessibilityState={{
            selected: value.id === selected.modelId && value.provider === selected.provider,
          }}
          onPress={() =>
            setSelected({
              ...selected,
              provider: value.provider,
              modelId: value.id,
              thinkingLevel: value.thinkingLevels.includes(selected.thinkingLevel)
                ? selected.thinkingLevel
                : (value.thinkingLevels[0] ?? "off"),
            })
          }
          style={styles.model}
        >
          <View style={styles.modelText}>
            <Text style={common.body}>{value.name}</Text>
            <Text style={common.hint}>{value.provider}</Text>
          </View>
          {value.id === selected.modelId && value.provider === selected.provider && (
            <Check size={20} color={colors.blue} />
          )}
        </Pressable>
      ))}
      <Text style={common.label}>思考等级</Text>
      <View style={styles.choices}>
        {model?.thinkingLevels.map((level) => (
          <Pressable
            key={level}
            accessibilityRole="radio"
            accessibilityState={{ selected: selected.thinkingLevel === level }}
            onPress={() => setSelected({ ...selected, thinkingLevel: level })}
            style={[styles.choice, selected.thinkingLevel === level && styles.selected]}
          >
            <Text style={common.body}>{thinkingLabels[level]}</Text>
          </Pressable>
        ))}
      </View>
      {!!modes.length && (
        <>
          <Text style={common.label}>沙盒策略</Text>
          <View style={styles.choices}>
            {modes.map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ selected: selected.sandboxMode === mode }}
                onPress={() => setSelected({ ...selected, sandboxMode: mode })}
                style={[styles.choice, selected.sandboxMode === mode && styles.selected]}
              >
                <Text style={common.body}>{sandboxLabels[mode]}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
      <Button
        disabled={busy || !model}
        onPress={() => {
          void run(async () => {
            await store.configure(selected);
            onClose();
          });
        }}
      >
        {busy ? "正在保存…" : "应用设置"}
      </Button>
    </Sheet>
  );
}
const styles = StyleSheet.create({
  model: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: 18,
    backgroundColor: colors.surface,
  },
  modelText: { flex: 1 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  choice: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  selected: { borderColor: colors.blue, backgroundColor: "#EDF2FE" },
});
