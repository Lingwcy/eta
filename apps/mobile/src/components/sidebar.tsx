import { useState } from "react";
import { useRouter } from "expo-router";
import {
  KeyboardAvoidingView,
  Platform,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Archive, Check, Folder, Plus, Settings, SquarePen, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BotThread } from "../bot/contracts.ts";
import { useMobile } from "../provider.tsx";
import { Button, colors, common, IconButton, SheetContent, useAction } from "../ui.tsx";

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
  const closePanel = () => {
    if (editing) setEditing(undefined);
    else if (menu) setMenu(undefined);
    else onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={closePanel}>
      <KeyboardAvoidingView
        style={[styles.overlay, (editing || menu) && styles.panelOverlay]}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel="关闭面板"
          onPress={closePanel}
        />
        {editing ? (
          <SheetContent
            title={editing?.thread ? "重命名会话" : "新建 Bot 项目"}
            onClose={() => setEditing(undefined)}
          >
            <TextInput
              accessibilityLabel={editing?.thread ? "会话名称" : "项目名称"}
              value={name}
              onChangeText={setName}
              placeholder={editing?.thread ? "会话名称" : "项目名称"}
              placeholderTextColor={colors.muted}
              style={common.field}
              autoFocus
              maxLength={256}
            />
            {!editing?.thread && (
              <Text style={common.hint}>项目会创建在 Bot 配置的工作空间根目录内。</Text>
            )}
            <Button
              disabled={busy || !name.trim()}
              onPress={() => {
                void run(async () => {
                  if (editing?.thread)
                    await store.metadata(editing.thread.id, { title: name.trim() });
                  else await store.createProject(name.trim());
                  setEditing(undefined);
                });
              }}
            >
              {busy ? "正在保存…" : "保存"}
            </Button>
          </SheetContent>
        ) : menu ? (
          <SheetContent title="管理会话" onClose={() => setMenu(undefined)}>
            <Text style={common.body}>{menu?.title}</Text>
            <Button secondary disabled={busy} onPress={() => edit(menu)}>
              重命名
            </Button>
            <Button
              secondary
              disabled={busy}
              onPress={() => {
                void run(async () => {
                  if (!menu) return;
                  await store.metadata(menu.id, { archived: !menu.archivedAt });
                  setMenu(undefined);
                });
              }}
            >
              {menu?.archivedAt ? "取消归档" : "归档会话"}
            </Button>
          </SheetContent>
        ) : (
          <View
            accessibilityViewIsModal
            style={[
              styles.drawer,
              { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 },
            ]}
          >
            <View style={styles.header}>
              <Text style={styles.brand}>eta-mobile</Text>
              <IconButton icon={X} label="关闭侧栏" onPress={onClose} />
            </View>
            <View style={styles.newChat}>
              <Button
                secondary
                disabled={!available}
                onPress={() => {
                  void run(() => {
                    store.newThread();
                    onClose();
                  });
                }}
              >
                新建会话
              </Button>
            </View>
            <ScrollView contentContainerStyle={styles.content}>
              <View style={styles.sectionHeading}>
                <Text style={styles.label}>项目</Text>
                <IconButton
                  icon={Plus}
                  label="新建项目"
                  disabled={!available}
                  onPress={() => edit()}
                />
              </View>
              {state.library?.workspaces.map((workspace) => {
                const project = state.library?.projects.find(
                  (value) => value.id === workspace.projectId,
                );
                return (
                  <Pressable
                    key={workspace.id}
                    accessibilityRole="button"
                    disabled={!available}
                    accessibilityState={{ selected: state.workspaceId === workspace.id }}
                    onPress={() => {
                      void run(() => store.newThread(workspace.id));
                    }}
                    style={[styles.row, state.workspaceId === workspace.id && styles.selected]}
                  >
                    <Folder size={18} color={colors.muted} />
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {project?.name ?? "项目"}
                      {workspace.kind === "worktree" ? " · 工作树" : ""}
                    </Text>
                    {state.workspaceId === workspace.id && <Check size={16} color={colors.blue} />}
                  </Pressable>
                );
              })}
              {!state.library?.workspaces.length && (
                <Text style={common.hint}>还没有项目，先创建一个。</Text>
              )}
              <View style={styles.sectionHeading}>
                <Text style={styles.label}>{archived ? "已归档会话" : "会话"}</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setArchived(!archived)}
                  style={styles.archiveToggle}
                >
                  <Archive size={16} color={colors.muted} />
                  <Text style={common.hint}>{archived ? "返回" : "归档"}</Text>
                </Pressable>
              </View>
              {threads.map((thread) => (
                <View
                  key={thread.id}
                  style={[styles.threadRow, thread.id === state.threadId && styles.selected]}
                >
                  <Pressable
                    accessibilityRole="button"
                    disabled={!available}
                    style={styles.threadOpen}
                    onPress={() => {
                      void run(async () => {
                        onClose();
                        await store.open(thread.id);
                      });
                    }}
                  >
                    <Text numberOfLines={2} style={styles.rowTitle}>
                      {thread.title || "未命名会话"}
                    </Text>
                  </Pressable>
                  <IconButton
                    icon={SquarePen}
                    label={`管理会话：${thread.title}`}
                    disabled={!available}
                    onPress={() => setMenu(thread)}
                  />
                </View>
              ))}
              {!threads.length && (
                <Text style={common.hint}>
                  {archived ? "没有已归档会话" : "这个项目还没有会话"}
                </Text>
              )}
            </ScrollView>
            <View style={styles.footer}>
              <Pressable
                accessibilityRole="button"
                style={styles.row}
                onPress={() => {
                  onClose();
                  router.push("/settings");
                }}
              >
                <Settings size={20} color={colors.text} />
                <Text style={styles.rowTitle}>连接与设置</Text>
              </Pressable>
              <Text numberOfLines={1} style={styles.url}>
                {state.url}
              </Text>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "#00000035" },
  panelOverlay: { justifyContent: "flex-end" },
  drawer: {
    flex: 1,
    width: "86%",
    maxWidth: 400,
    backgroundColor: colors.background,
    borderTopRightRadius: 28,
    borderBottomRightRadius: 28,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  brand: { fontSize: 20, fontWeight: "600", color: colors.text },
  newChat: { paddingHorizontal: 20, paddingVertical: 18 },
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    paddingLeft: 10,
  },
  label: { fontSize: 13, fontWeight: "600", color: colors.muted },
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 15,
  },
  selected: { backgroundColor: colors.soft },
  rowTitle: { flex: 1, fontSize: 15, color: colors.text, lineHeight: 22 },
  archiveToggle: { flexDirection: "row", alignItems: "center", gap: 6, padding: 12 },
  threadRow: { flexDirection: "row", alignItems: "center", borderRadius: 15, marginTop: 5 },
  threadOpen: { flex: 1, paddingHorizontal: 12, paddingVertical: 14 },
  footer: { borderTopWidth: 1, borderTopColor: colors.border, padding: 14 },
  url: { fontSize: 12, color: colors.muted, paddingHorizontal: 12, marginTop: 8 },
});
