import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ArrowDown, Menu, SquarePen } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobile } from "../provider.tsx";
import { draftKey } from "../bot/store.ts";
import { conversationRows, taskLabel, isActivityMessage } from "../conversation.ts";
import { MessageView } from "../components/message.tsx";
import { Approvals } from "../components/approvals.tsx";
import { ConfigurationSheet, sandboxLabels, thinkingLabels } from "../components/configuration.tsx";
import { ComposerInput } from "../components/composer-input.tsx";
import { Sidebar } from "../components/sidebar.tsx";
import { Button, colors, common, IconButton, useAction } from "../ui.tsx";
import { SettingsScreen } from "./settings.tsx";

export function ChatScreen() {
  const { state, store } = useMobile();
  const router = useRouter();
  const [sidebar, setSidebar] = useState(false);
  const [configuration, setConfiguration] = useState(false);
  const [away, setAway] = useState(false);
  const { busy, run } = useAction();

  const atBottom = useRef(true);
  const list = useRef<FlatList<ReturnType<typeof conversationRows>[number]>>(null);
  const snapshot = state.thread?.snapshot;
  const rows = useMemo(() => (snapshot ? conversationRows(snapshot) : []), [snapshot]);
  const workspace = state.library?.workspaces.find((value) => value.id === state.workspaceId);
  const project = state.library?.projects.find((value) => value.id === workspace?.projectId);
  const model = state.library?.models.find(
    (value) =>
      value.id === state.configuration?.modelId && value.provider === state.configuration?.provider,
  );
  const draft = state.drafts[draftKey(state)] ?? "";
  const connected = state.status === "connected";
  const running = !!snapshot?.operation;
  const allowed = connected && !busy && !state.sending && !state.opening;
  useEffect(() => {
    atBottom.current = true;
    setAway(false);
  }, [state.threadId]);

  if (state.status === "loading")
    return (
      <SafeAreaView style={[common.screen, styles.loading]}>
        <Text style={common.hint}>正在读取连接…</Text>
      </SafeAreaView>
    );
  if (!state.url) return <SettingsScreen onboarding />;

  const footer = (
    <>
      {snapshot && <Approvals snapshot={snapshot} />}
      {!!taskLabel(snapshot) && (
        <View style={styles.task}>
          <Text selectable style={common.hint}>
            {taskLabel(snapshot)}
          </Text>
        </View>
      )}
      {snapshot?.sandbox && !snapshot.sandbox.available && (
        <Text style={common.error}>{snapshot.sandbox.reason ?? "Bot 沙盒不可用"}</Text>
      )}
      {snapshot?.recoveryRequired && (
        <View style={styles.resume}>
          <Button
            secondary
            disabled={!allowed || !!snapshot.blockedReason}
            onPress={() => {
              void run(() => store.control("resume"));
            }}
          >
            恢复任务
          </Button>
        </View>
      )}
      {!!state.thread?.thread.archivedAt && (
        <View style={styles.resume}>
          <Button
            secondary
            disabled={!allowed}
            onPress={() => {
              void run(() => store.metadata(state.threadId!, { archived: false }));
            }}
          >
            取消归档
          </Button>
        </View>
      )}
    </>
  );
  return (
    <SafeAreaView style={common.screen}>
      <KeyboardAvoidingView
        style={common.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          <IconButton icon={Menu} label="打开项目与会话" onPress={() => setSidebar(true)} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="选择项目或会话"
            onPress={() => setSidebar(true)}
            style={styles.title}
          >
            <Text numberOfLines={1} style={styles.titleText}>
              {state.thread?.thread.title || "新会话"}
            </Text>
            <Text numberOfLines={1} style={styles.project}>
              {project?.name ?? "选择 Bot 项目"}
            </Text>
          </Pressable>
          <IconButton
            icon={SquarePen}
            label="新建会话"
            disabled={state.sending}
            onPress={() => {
              void run(() => store.newThread());
            }}
          />
        </View>
        {state.status !== "connected" && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {state.status === "reconnecting" ? "正在重连 Bot" : (state.error ?? "Bot 连接不可用")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void run(() => store.reconnect());
              }}
              disabled={busy}
            >
              <Text style={styles.link}>重连</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => router.push("/settings")}>
              <Text style={styles.link}>设置</Text>
            </Pressable>
          </View>
        )}
        {connected && state.error && (
          <View style={styles.banner}>
            <Text accessibilityRole="alert" style={styles.bannerText}>
              {state.error}
            </Text>
          </View>
        )}
        <View style={styles.transcript}>
          <FlatList
            ref={list}
            data={rows}
            keyExtractor={(row) => row.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={[styles.messages, !rows.length && styles.emptyList]}
            renderItem={({ item, index }) =>
              snapshot ? (
                <MessageView
                  message={item.message}
                  snapshot={snapshot}
                  compactAfter={
                    isActivityMessage(item.message) &&
                    Boolean(rows[index + 1] && isActivityMessage(rows[index + 1]!.message))
                  }
                />
              ) : null
            }
            initialNumToRender={12}
            maxToRenderPerBatch={8}
            windowSize={7}
            onScroll={({ nativeEvent }) => {
              const near =
                nativeEvent.contentSize.height -
                  nativeEvent.layoutMeasurement.height -
                  nativeEvent.contentOffset.y <
                80;
              atBottom.current = near;
              setAway(!near);
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (atBottom.current) list.current?.scrollToEnd({ animated: false });
            }}
            onLayout={() => {
              if (atBottom.current) list.current?.scrollToEnd({ animated: false });
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>
                  {state.opening
                    ? "正在读取会话…"
                    : state.threadId && !state.thread
                      ? "会话尚未加载"
                      : "从这里开始工作"}
                </Text>
                <Text style={styles.emptyHint}>
                  {!state.library?.models.length
                    ? "Bot 尚未提供模型，请先在 Bot 配置模型凭据"
                    : state.thread && !state.opening
                      ? "这个会话还没有消息"
                      : state.threadId
                        ? "连接 Bot 后查看会话内容"
                        : project
                          ? `任务将在 ${project.name} 中运行`
                          : "先选择或创建一个 Bot 项目"}
                </Text>
                {state.threadId && !state.thread && !state.opening && (
                  <Button
                    secondary
                    disabled={!connected || busy}
                    onPress={() => {
                      void run(() => store.open(state.threadId!));
                    }}
                  >
                    重新加载会话
                  </Button>
                )}
              </View>
            }
            ListFooterComponent={footer}
          />
          {away && (
            <View style={styles.jump}>
              <IconButton
                icon={ArrowDown}
                label="滚动到最新消息"
                onPress={() => {
                  atBottom.current = true;
                  setAway(false);
                  list.current?.scrollToEnd({ animated: true });
                }}
              />
            </View>
          )}
        </View>
        {state.pending && (
          <View style={styles.pending}>
            <Text style={styles.pendingTitle}>
              {state.sending ? "正在提交消息…" : "上次消息的接收状态待确认"}
            </Text>
            <Text numberOfLines={2} style={common.hint}>
              {state.pending.prompt}
            </Text>
            {!state.sending && (
              <Button
                secondary
                disabled={!connected || busy}
                onPress={() => {
                  void run(() => store.retrySend());
                }}
              >
                重试并确认接收
              </Button>
            )}
          </View>
        )}
        <View style={styles.composerArea}>
          <ComposerInput
            value={draft}
            onChangeText={(value) => store.setDraft(value)}
            onSubmit={() => {
              void run(() => store.send());
            }}
            onStop={() => {
              void run(() => store.control("stop"));
            }}
            onOpenConfiguration={() => setConfiguration(true)}
            running={running}
            canStop={allowed && snapshot?.operation?.status !== "aborting"}
            canSend={
              allowed &&
              !state.pending &&
              Boolean(draft.trim()) &&
              Boolean(workspace) &&
              Boolean(model) &&
              !state.thread?.thread.archivedAt &&
              !snapshot?.recoveryRequired &&
              !snapshot?.blockedReason &&
              !snapshot?.faulted
            }
            disabled={!connected || state.opening || !!state.pending}
            modelName={model?.name}
            thinkingLevel={state.configuration?.thinkingLevel}
            thinkingLevelLabel={
              state.configuration ? thinkingLabels[state.configuration.thinkingLevel] : undefined
            }
            sandboxMode={state.configuration?.sandboxMode ?? snapshot?.sandbox?.mode}
            sandboxModeLabel={
              state.configuration?.sandboxMode
                ? sandboxLabels[state.configuration.sandboxMode]
                : snapshot?.sandbox?.mode
                  ? sandboxLabels[snapshot.sandbox.mode]
                  : undefined
            }
            contextTokens={state.thread?.contextTokens}
          />
        </View>
      </KeyboardAvoidingView>
      <Sidebar visible={sidebar} onClose={() => setSidebar(false)} />
      {configuration && state.configuration && (
        <ConfigurationSheet
          configuration={state.configuration}
          onClose={() => setConfiguration(false)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loading: { justifyContent: "center", alignItems: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, alignItems: "center", gap: 2 },
  titleText: { fontSize: 16, fontWeight: "600", color: colors.text },
  project: { fontSize: 12, color: colors.muted },
  banner: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 14,
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bannerText: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 18 },
  link: { color: colors.blue, fontSize: 13, fontWeight: "500", paddingVertical: 4 },
  transcript: { flex: 1 },
  messages: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 12,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
  emptyList: { flexGrow: 1 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 10, paddingBottom: 64 },
  emptyTitle: { fontSize: 22, fontWeight: "600", color: colors.text, letterSpacing: -0.2 },
  emptyHint: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    maxWidth: 320,
  },
  task: { marginTop: 4, marginBottom: 12 },
  resume: { marginVertical: 10 },
  jump: {
    position: "absolute",
    bottom: 14,
    right: 20,
    borderRadius: 20,
  },
  pending: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    gap: 6,
    backgroundColor: colors.soft,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pendingTitle: { fontSize: 13, fontWeight: "600", color: colors.text },
  composerArea: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 4 : 8,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
});
