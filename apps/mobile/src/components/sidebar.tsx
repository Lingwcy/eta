import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
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
import {
  Archive,
  Check,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  SquarePen,
  X,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BotThread } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { colors, useAction } from "../ui.tsx";

export function Sidebar({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { state, store } = useMobile();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<{ thread?: BotThread }>();
  const [name, setName] = useState("");
  const [menu, setMenu] = useState<BotThread>();
  const { busy, run } = useAction();
  const available = state.status === "connected" && !state.sending && !busy;

  const backdropAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(-340)).current;

  useEffect(() => {
    if (visible) {
      backdropAnim.setValue(0);
      slideAnim.setValue(-340);
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
    }
  }, [visible, backdropAnim, slideAnim]);

  const handleClose = () => {
    Animated.parallel([
      Animated.timing(backdropAnim, {
        toValue: 0,
        duration: 160,
        useNativeDriver: true,
      }),
      Animated.timing(slideAnim, {
        toValue: -340,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(() => {
      setEditing(undefined);
      setMenu(undefined);
      onClose();
    });
  };

  const closePanel = () => {
    if (editing) setEditing(undefined);
    else if (menu) setMenu(undefined);
    else handleClose();
  };

  const threads =
    state.library?.threads
      .filter(
        (thread) => !!thread.archivedAt === archived && thread.workspaceId === state.workspaceId,
      )
      .sort((left, right) => right.createdAt - left.createdAt) ?? [];

  const edit = (thread?: BotThread) => {
    setName(thread?.title ?? "");
    setEditing({ thread });
    setMenu(undefined);
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={closePanel}>
      <View style={styles.modalRoot}>
        {/* 背景蒙层：固定铺满，仅透明度渐变 */}
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: backdropAnim }]}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel="关闭侧栏"
            onPress={closePanel}
          />
        </Animated.View>

        {/* 抽屉容器：自左侧平滑滑入 */}
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.drawer,
            {
              transform: [{ translateX: slideAnim }],
              paddingTop: Math.max(insets.top, 8),
            },
          ]}
        >
          {/* 顶栏：Brand + 状态指示 + 关闭按钮 */}
          <View style={styles.header}>
            <View style={styles.brandRow}>
              <Text style={styles.brand}>eta</Text>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>mobile</Text>
              </View>
              <View
                style={[
                  styles.statusDot,
                  state.status === "connected"
                    ? styles.statusDotConnected
                    : state.status === "connecting"
                      ? styles.statusDotConnecting
                      : styles.statusDotDisconnected,
                ]}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭侧栏"
              onPress={handleClose}
              hitSlop={8}
              style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
            >
              <X size={14} color={colors.muted} />
            </Pressable>
          </View>

          {/* 新建会话按钮：紧凑桌面级质感 */}
          <View style={styles.newChat}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="新建会话"
              disabled={!available}
              onPress={() => {
                void run(() => {
                  store.newThread();
                  handleClose();
                });
              }}
              style={({ pressed }) => [
                styles.newChatButton,
                pressed && styles.newChatButtonPressed,
                !available && styles.buttonDisabled,
              ]}
            >
              <SquarePen size={16} color={colors.text} />
              <Text style={styles.newChatText}>新建会话</Text>
            </Pressable>
          </View>

          {/* 滚动区域 */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            showsVerticalScrollIndicator={false}
          >
            {/* 项目区域标题 */}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionLabel}>项目</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新建项目"
                disabled={!available}
                hitSlop={6}
                onPress={() => edit()}
                style={({ pressed }) => [
                  styles.sectionAction,
                  pressed && styles.sectionActionPressed,
                  !available && styles.buttonDisabled,
                ]}
              >
                <Plus size={12} color={colors.muted} />
                <Text style={styles.sectionActionText}>新建</Text>
              </Pressable>
            </View>

            {/* 项目列表 */}
            {state.library?.workspaces
              .filter((workspace) => workspace.kind !== "temporary")
              .map((workspace) => {
                const project = state.library?.projects.find(
                  (value) => value.id === workspace.projectId,
                );
                const isSelected = state.workspaceId === workspace.id;
                return (
                  <Pressable
                    key={workspace.id}
                    accessibilityRole="button"
                    disabled={!available}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => {
                      void run(() => store.newThread(workspace.id));
                    }}
                    style={({ pressed }) => [
                      styles.projectRow,
                      isSelected && styles.rowSelected,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <Folder size={14} color={isSelected ? colors.text : colors.muted} />
                    <Text
                      numberOfLines={1}
                      style={[styles.projectTitle, isSelected && styles.projectTitleSelected]}
                    >
                      {project?.name ?? "项目"}
                      {workspace.kind === "worktree" ? " · 工作树" : ""}
                    </Text>
                    {isSelected && <Check size={13} color={colors.blue} />}
                  </Pressable>
                );
              })}
            {!state.library?.workspaces.length && (
              <Text style={styles.emptyHint}>还没有项目，点击上方新建。</Text>
            )}

            {/* 会话区域标题 */}
            <View style={[styles.sectionHeading, { marginTop: 12 }]}>
              <Text style={styles.sectionLabel}>{archived ? "已归档会话" : "会话"}</Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => setArchived(!archived)}
                style={({ pressed }) => [
                  styles.sectionAction,
                  pressed && styles.sectionActionPressed,
                ]}
              >
                <Archive size={12} color={colors.muted} />
                <Text style={styles.sectionActionText}>{archived ? "返回会话" : "归档"}</Text>
              </Pressable>
            </View>

            {/* 会话列表 */}
            {threads.map((thread) => {
              const isSelected = thread.id === state.threadId;
              return (
                <View key={thread.id} style={[styles.threadRow, isSelected && styles.rowSelected]}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={!available}
                    style={styles.threadOpen}
                    onPress={() => {
                      void run(async () => {
                        handleClose();
                        await store.open(thread.id);
                      });
                    }}
                  >
                    <Text
                      numberOfLines={1}
                      style={[styles.threadTitle, isSelected && styles.threadTitleSelected]}
                    >
                      {thread.title || "未命名会话"}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`管理会话：${thread.title}`}
                    disabled={!available}
                    hitSlop={6}
                    onPress={() => setMenu(thread)}
                    style={({ pressed }) => [
                      styles.threadMoreButton,
                      pressed && styles.threadMoreButtonPressed,
                    ]}
                  >
                    <MoreHorizontal size={14} color={colors.muted} />
                  </Pressable>
                </View>
              );
            })}
            {!threads.length && (
              <Text style={styles.emptyHint}>
                {archived ? "没有已归档会话" : "这个项目还没有会话"}
              </Text>
            )}
          </ScrollView>

          {/* 底栏：设置与连接状态卡片 */}
          <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.footerCard, pressed && styles.footerCardPressed]}
              onPress={() => {
                handleClose();
                router.push("/settings");
              }}
            >
              <View style={styles.footerRow}>
                <View style={styles.footerLeft}>
                  <Settings size={14} color={colors.muted} />
                  <Text style={styles.footerTitle}>连接与设置</Text>
                </View>
                <ChevronRight size={13} color={colors.muted} />
              </View>
              <View style={styles.footerSubRow}>
                <View
                  style={[
                    styles.footerStatusDot,
                    state.status === "connected"
                      ? styles.statusDotConnected
                      : state.status === "connecting"
                        ? styles.statusDotConnecting
                        : styles.statusDotDisconnected,
                  ]}
                />
                <Text numberOfLines={1} style={styles.footerUrl}>
                  {state.url || "未配置服务器"}
                </Text>
              </View>
            </Pressable>
          </View>
        </Animated.View>

        {/* 会话操作弹层 (类似于桌面端 ThreadContextMenu) */}
        {Boolean(menu) && (
          <View style={StyleSheet.absoluteFill}>
            <Pressable
              style={[StyleSheet.absoluteFill, styles.subBackdrop]}
              onPress={() => setMenu(undefined)}
            />
            <View style={[styles.menuSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={styles.menuHandle} />
              <Text numberOfLines={1} style={styles.menuHeaderTitle}>
                {menu?.title || "未命名会话"}
              </Text>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => edit(menu)}
                style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
              >
                <Pencil size={15} color={colors.text} />
                <Text style={styles.menuItemText}>重命名</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  void run(async () => {
                    if (!menu) return;
                    await store.metadata(menu.id, { archived: !menu.archivedAt });
                    setMenu(undefined);
                  });
                }}
                style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
              >
                <Archive size={15} color={colors.text} />
                <Text style={styles.menuItemText}>
                  {menu?.archivedAt ? "取消归档" : "归档会话"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => setMenu(undefined)}
                style={({ pressed }) => [
                  styles.menuItem,
                  styles.menuCancelItem,
                  pressed && styles.menuItemPressed,
                ]}
              >
                <X size={15} color={colors.muted} />
                <Text style={styles.menuCancelText}>取消</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* 重命名 / 新建项目弹层 */}
        {Boolean(editing) && (
          <View style={StyleSheet.absoluteFill}>
            <Pressable
              style={[StyleSheet.absoluteFill, styles.subBackdrop]}
              onPress={() => setEditing(undefined)}
            />
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              style={styles.editCenter}
            >
              <View style={styles.editDialog}>
                <Text style={styles.editTitle}>
                  {editing?.thread ? "重命名会话" : "新建 Bot 项目"}
                </Text>
                {!editing?.thread && (
                  <Text style={styles.editHint}>项目会创建在 Bot 配置的工作空间根目录内。</Text>
                )}
                <TextInput
                  accessibilityLabel={editing?.thread ? "会话名称" : "项目名称"}
                  value={name}
                  onChangeText={setName}
                  placeholder={editing?.thread ? "输入会话名称…" : "输入项目名称…"}
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                  autoFocus
                  maxLength={256}
                />
                <View style={styles.editActions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => setEditing(undefined)}
                    style={({ pressed }) => [
                      styles.editCancelButton,
                      pressed && styles.buttonPressed,
                    ]}
                  >
                    <Text style={styles.editCancelText}>取消</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || !name.trim()}
                    onPress={() => {
                      void run(async () => {
                        if (editing?.thread)
                          await store.metadata(editing.thread.id, { title: name.trim() });
                        else await store.createProject(name.trim());
                        setEditing(undefined);
                      });
                    }}
                    style={({ pressed }) => [
                      styles.editSaveButton,
                      pressed && styles.buttonPressed,
                      (busy || !name.trim()) && styles.buttonDisabled,
                    ]}
                  >
                    <Text style={styles.editSaveText}>{busy ? "保存中" : "保存"}</Text>
                  </Pressable>
                </View>
              </View>
            </KeyboardAvoidingView>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: "#00000040",
  },
  drawer: {
    width: "82%",
    maxWidth: 320,
    height: "100%",
    backgroundColor: colors.background,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  brand: {
    fontSize: 16,
    fontWeight: "700",
    color: colors.text,
    letterSpacing: -0.4,
  },
  badge: {
    paddingHorizontal: 5,
    paddingVertical: 1.5,
    borderRadius: 4,
    backgroundColor: colors.soft,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "600",
    color: colors.muted,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotConnected: { backgroundColor: colors.success },
  statusDotConnecting: { backgroundColor: "#EAB308" },
  statusDotDisconnected: { backgroundColor: colors.danger },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonPressed: {
    backgroundColor: colors.softHover,
  },
  newChat: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
  },
  newChatButton: {
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.soft,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  newChatButtonPressed: {
    backgroundColor: colors.softHover,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  newChatText: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 10,
    paddingBottom: 16,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 6,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.muted,
  },
  sectionAction: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  sectionActionPressed: {
    backgroundColor: colors.softHover,
  },
  sectionActionText: {
    fontSize: 13,
    fontWeight: "500",
    color: colors.muted,
  },
  projectRow: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    borderRadius: 6,
    marginVertical: 1,
  },
  rowSelected: {
    backgroundColor: colors.softHover,
  },
  rowPressed: {
    backgroundColor: colors.soft,
  },
  projectTitle: {
    flex: 1,
    fontSize: 15,
    color: "#3F3F3E",
  },
  projectTitleSelected: {
    fontWeight: "600",
    color: colors.text,
  },
  emptyHint: {
    fontSize: 12,
    color: colors.muted,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  threadRow: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 6,
    marginVertical: 1,
    paddingLeft: 8,
    paddingRight: 4,
  },
  threadOpen: {
    flex: 1,
    height: "100%",
    justifyContent: "center",
  },
  threadTitle: {
    fontSize: 15,
    color: "#3F3F3E",
  },
  threadTitleSelected: {
    fontWeight: "600",
    color: colors.text,
  },
  threadMoreButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  threadMoreButtonPressed: {
    backgroundColor: "#DCDCDA",
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 10,
    paddingTop: 8,
    backgroundColor: colors.background,
  },
  footerCard: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    gap: 4,
  },
  footerCardPressed: {
    backgroundColor: colors.softHover,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  footerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  footerTitle: {
    fontSize: 12.5,
    fontWeight: "500",
    color: colors.text,
  },
  footerSubRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 20,
  },
  footerStatusDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  footerUrl: {
    flex: 1,
    fontSize: 10.5,
    color: colors.muted,
  },
  subBackdrop: {
    backgroundColor: "#00000030",
  },
  menuSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  menuHandle: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: "#D4D4D4",
    alignSelf: "center",
    marginBottom: 8,
  },
  menuHeaderTitle: {
    fontSize: 12,
    color: colors.muted,
    fontWeight: "500",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle,
    marginBottom: 4,
  },
  menuItem: {
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    marginVertical: 1,
  },
  menuItemPressed: {
    backgroundColor: colors.softHover,
  },
  menuItemText: {
    fontSize: 13.5,
    fontWeight: "500",
    color: colors.text,
  },
  menuCancelItem: {
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  menuCancelText: {
    fontSize: 13.5,
    color: colors.muted,
  },
  editCenter: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  editDialog: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 8,
  },
  editTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: colors.text,
    marginBottom: 4,
  },
  editHint: {
    fontSize: 12,
    color: colors.muted,
    marginBottom: 10,
    lineHeight: 16,
  },
  editInput: {
    height: 38,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingHorizontal: 10,
    fontSize: 13.5,
    color: colors.text,
    marginVertical: 8,
  },
  editActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 8,
  },
  editCancelButton: {
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 6,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  editCancelText: {
    fontSize: 13,
    color: colors.text,
    fontWeight: "500",
  },
  editSaveButton: {
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 6,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  editSaveText: {
    fontSize: 13,
    color: colors.surface,
    fontWeight: "600",
  },
  buttonPressed: {
    opacity: 0.75,
  },
});
