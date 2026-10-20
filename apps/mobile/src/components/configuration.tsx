import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Check, Cpu, Search, Shield, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Configuration } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { applySelection } from "./configuration-projection.ts";
import { colors, useAction } from "../ui.tsx";

export const thinkingLabels: Record<string, string> = {
  off: "关",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export const sandboxLabels: Record<string, string> = {
  "read-only": "只读",
  "workspace-write": "工作区",
  "danger-full-access": "完全访问",
};

export function ConfigurationSheet({
  configuration,
  onClose,
}: {
  configuration: Configuration;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { state, store } = useMobile();
  const [selected, setSelected] = useState(configuration);
  const [query, setQuery] = useState("");
  const [activeProvider, setActiveProvider] = useState<string | null>(
    configuration.provider ?? null,
  );
  const { busy, run } = useAction();

  const backdropAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(340)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(backdropAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [backdropAnim, slideAnim]);

  const handleClose = () => {
    Animated.parallel([
      Animated.timing(backdropAnim, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: 340,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      onClose();
    });
  };

  const allModels = state.library?.models ?? [];
  const model = allModels.find(
    (value) => value.id === selected.modelId && value.provider === selected.provider,
  );

  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const m of allModels) set.add(m.provider);
    return Array.from(set);
  }, [allModels]);

  const visibleModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return allModels.filter((m) => `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(q));
    }
    if (activeProvider !== null) {
      return allModels.filter((m) => m.provider === activeProvider);
    }
    return allModels;
  }, [allModels, query, activeProvider]);

  const modes =
    state.thread?.snapshot.sandbox?.allowedModes ?? state.library?.allowedSandboxModes ?? [];

  const handleCycleSandbox = () => {
    if (!modes.length) return;
    const currentIndex = modes.indexOf(selected.sandboxMode ?? modes[0]!);
    const nextMode = modes[(currentIndex + 1) % modes.length]!;
    setSelected({ ...selected, sandboxMode: nextMode });
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={handleClose}>
      <View style={styles.modalRoot}>
        {/* 固定蒙层：只渐变透明度，绝不随弹窗位移 */}
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropAnim }]}
        >
          <Pressable
            accessibilityLabel="关闭面板"
            onPress={handleClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>

        {/* 仅弹窗从底部滑出 */}
        <KeyboardAvoidingView
          style={styles.keyboardContainer}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          pointerEvents="box-none"
        >
          <Animated.View
            accessibilityViewIsModal
            style={[
              styles.sheet,
              {
                transform: [{ translateY: slideAnim }],
                paddingBottom: Math.max(insets.bottom, 10),
              },
            ]}
          >
            {/* 顶部抓手条 */}
            <View style={styles.handle} />

            {/* 紧凑搜索栏 + 关闭按钮 */}
            <View style={styles.headerRow}>
              <View style={styles.searchBox}>
                <Search size={13} color={colors.muted} />
                <TextInput
                  accessibilityLabel="搜索模型"
                  placeholder="搜索模型或服务商…"
                  placeholderTextColor={colors.muted}
                  value={query}
                  onChangeText={setQuery}
                  style={styles.searchInput}
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                {Boolean(query) && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="清空搜索"
                    onPress={() => setQuery("")}
                    hitSlop={6}
                  >
                    <X size={13} color={colors.muted} />
                  </Pressable>
                )}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭"
                onPress={handleClose}
                hitSlop={6}
                style={styles.closeButton}
              >
                <X size={16} color={colors.muted} />
              </Pressable>
            </View>

            {/* Provider 分类胶囊标签 (横向滚动，单行) */}
            <View style={styles.providerRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.providerScroll}
              >
                <Pressable
                  accessibilityRole="tab"
                  accessibilityState={{ selected: activeProvider === null && !query }}
                  hitSlop={6}
                  onPress={() => {
                    setActiveProvider(null);
                    setQuery("");
                  }}
                  style={[
                    styles.providerTab,
                    activeProvider === null && !query && styles.providerTabActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.providerTabText,
                      activeProvider === null && !query && styles.providerTabTextActive,
                    ]}
                  >
                    全部
                  </Text>
                </Pressable>
                {providers.map((p) => {
                  const isActive = activeProvider === p && !query;
                  return (
                    <Pressable
                      key={p}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: isActive }}
                      hitSlop={6}
                      onPress={() => {
                        setActiveProvider(p);
                        setQuery("");
                      }}
                      style={[styles.providerTab, isActive && styles.providerTabActive]}
                    >
                      <Text
                        style={[styles.providerTabText, isActive && styles.providerTabTextActive]}
                      >
                        {p}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>

            {/* 紧凑模型列表 (内部滚动容器，固定高度 ~128px) */}
            <View style={styles.modelListWrapper}>
              <ScrollView
                style={styles.modelListScroll}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
              >
                {visibleModels.map((entry, idx) => {
                  const isSelected =
                    entry.id === selected.modelId && entry.provider === selected.provider;
                  return (
                    <Pressable
                      key={`${entry.provider}:${entry.id}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                      onPress={() =>
                        setSelected({
                          ...selected,
                          provider: entry.provider,
                          modelId: entry.id,
                          thinkingLevel: entry.thinkingLevels.includes(selected.thinkingLevel)
                            ? selected.thinkingLevel
                            : (entry.thinkingLevels[0] ?? "off"),
                        })
                      }
                      style={({ pressed }) => [
                        styles.menuItem,
                        isSelected && styles.menuItemSelected,
                        pressed && styles.menuItemPressed,
                        idx > 0 && styles.menuItemBorder,
                      ]}
                    >
                      <Cpu size={13} color={isSelected ? colors.text : colors.muted} />
                      <View style={styles.menuItemContent}>
                        <Text
                          numberOfLines={1}
                          style={[styles.menuItemTitle, isSelected && styles.menuItemTitleSelected]}
                        >
                          {entry.name}
                        </Text>
                        {(activeProvider === null || Boolean(query.trim())) && (
                          <Text numberOfLines={1} style={styles.menuItemProvider}>
                            {entry.provider}
                          </Text>
                        )}
                      </View>
                      {isSelected && <Check size={13} strokeWidth={2.4} color={colors.text} />}
                    </Pressable>
                  );
                })}
                {!visibleModels.length && (
                  <View style={styles.emptyBox}>
                    <Text style={styles.emptyText}>未找到匹配的模型</Text>
                  </View>
                )}
              </ScrollView>
            </View>

            {/* 底部紧凑设置栏：思考等级 + 沙盒模式 + 确定按钮 (单行整合) */}
            <View style={styles.footerRow}>
              <View style={styles.optionsGroup}>
                {/* 思考级别 */}
                {model && model.thinkingLevels.length > 1 && (
                  <View style={styles.thinkingGroup}>
                    <Text style={styles.optionLabel}>思考:</Text>
                    {model.thinkingLevels.map((lvl) => {
                      const isLvlSelected = selected.thinkingLevel === lvl;
                      return (
                        <Pressable
                          key={lvl}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: isLvlSelected }}
                          hitSlop={6}
                          onPress={() => setSelected({ ...selected, thinkingLevel: lvl })}
                          style={[styles.miniChip, isLvlSelected && styles.miniChipActive]}
                        >
                          <Text
                            style={[
                              styles.miniChipText,
                              isLvlSelected && styles.miniChipTextActive,
                            ]}
                          >
                            {thinkingLabels[lvl] ?? lvl}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}

                {/* 沙盒模式快捷切换 */}
                {modes.length > 1 && selected.sandboxMode && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`沙盒策略: ${sandboxLabels[selected.sandboxMode]}, 点击切换`}
                    hitSlop={6}
                    onPress={handleCycleSandbox}
                    style={styles.sandboxChip}
                  >
                    <Shield size={11} color={colors.muted} />
                    <Text style={styles.sandboxChipText}>
                      {sandboxLabels[selected.sandboxMode] ?? selected.sandboxMode}
                    </Text>
                  </Pressable>
                )}
              </View>

              {/* 确定应用按钮 */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="应用设置"
                hitSlop={6}
                disabled={busy || !model}
                onPress={() => {
                  void run(async () => {
                    await store.configure(
                      applySelection(configuration, selected, state.configuration ?? configuration),
                    );
                    handleClose();
                  });
                }}
                style={({ pressed }) => [
                  styles.confirmButton,
                  pressed && styles.buttonPressed,
                  (busy || !model) && styles.buttonDisabled,
                ]}
              >
                <Text style={styles.confirmText}>{busy ? "保存中" : "确定"}</Text>
              </Pressable>
            </View>
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: "#00000045",
  },
  keyboardContainer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    maxHeight: "62%",
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 8,
  },
  handle: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: "#D4D4D4",
    alignSelf: "center",
    marginBottom: 8,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  searchBox: {
    flex: 1,
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: 12,
    color: colors.text,
    paddingVertical: 0,
  },
  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  providerRow: {
    marginBottom: 6,
    height: 32,
  },
  providerScroll: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
  },
  providerTab: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  providerTabActive: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  providerTabText: {
    fontSize: 11,
    color: colors.muted,
    fontWeight: "500",
  },
  providerTabTextActive: {
    color: colors.surface,
    fontWeight: "600",
  },
  modelListWrapper: {
    maxHeight: 246,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  modelListScroll: {
    flexGrow: 0,
  },
  menuItem: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 9,
    backgroundColor: colors.surface,
  },
  menuItemBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  menuItemSelected: {
    backgroundColor: colors.soft,
  },
  menuItemPressed: {
    opacity: 0.7,
  },
  menuItemContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  menuItemTitle: {
    fontSize: 12,
    color: colors.text,
    fontWeight: "500",
    flexShrink: 1,
  },
  menuItemTitleSelected: {
    fontWeight: "600",
  },
  menuItemProvider: {
    fontSize: 10,
    color: colors.muted,
  },
  emptyBox: {
    padding: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: 12,
    color: colors.muted,
  },
  footerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingTop: 8,
    marginTop: 4,
  },
  optionsGroup: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "nowrap",
  },
  thinkingGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  optionLabel: {
    fontSize: 11,
    color: colors.muted,
    marginRight: 2,
  },
  miniChip: {
    minHeight: 32,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  miniChipActive: {
    backgroundColor: colors.text,
    borderColor: colors.text,
  },
  miniChipText: {
    fontSize: 10,
    color: colors.text,
  },
  miniChipTextActive: {
    color: colors.surface,
    fontWeight: "600",
  },
  sandboxChip: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sandboxChipText: {
    fontSize: 10,
    color: colors.muted,
    fontWeight: "500",
  },
  confirmButton: {
    height: 32,
    paddingHorizontal: 16,
    borderRadius: 16,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmText: {
    color: colors.surface,
    fontSize: 12,
    fontWeight: "600",
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
});
