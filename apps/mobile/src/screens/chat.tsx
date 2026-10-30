import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { pickedImage } from "../images.ts";
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
import { buildToolIndex, conversationRows, taskLabel, isActivityMessage } from "../conversation.ts";
import { MessageView } from "../components/message.tsx";
import { Approvals } from "../components/approvals.tsx";
import {
  ChatEmptyState,
  ConnectionBanner,
  ErrorStrip,
  PendingNotice,
  TaskStatus,
  taskTone,
} from "../components/chat-status.tsx";
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
  const [pickingImages, setPickingImages] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const mounted = useRef(true);
  const pickerBusy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setImageError(undefined);
  }, [state.url, state.threadId, state.workspaceId]);
  const selectImages = async () => {
    if (pickerBusy.current) return;
    const owner = store.captureImageDraft();
    pickerBusy.current = true;
    setPickingImages(true);
    setImageError(undefined);
    try {
      // The system photo picker grants access only to selected photos; no broad library permission.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: 4,
        base64: true,
        quality: 0.8,
      });
      if (!mounted.current || !owner.isCurrent() || result.canceled) return;
      owner.add(result.assets.map(pickedImage));
    } catch (error) {
      if (mounted.current && owner.isCurrent())
        setImageError(error instanceof Error ? error.message : "无法选择图片，请重试");
    } finally {
      pickerBusy.current = false;
      if (mounted.current) setPickingImages(false);
    }
  };
  const { busy, run } = useAction();

  const atBottom = useRef(true);
  const list = useRef<FlatList<ReturnType<typeof conversationRows>[number]>>(null);
  const snapshot = state.thread?.snapshot;
  const rows = useMemo(() => (snapshot ? conversationRows(snapshot) : []), [snapshot]);
  const tools = useMemo(() => (snapshot ? buildToolIndex(snapshot) : undefined), [snapshot]);
  const workspace = state.library?.workspaces.find((value) => value.id === state.workspaceId);
  const project = state.library?.projects.find((value) => value.id === workspace?.projectId);
  const model = state.library?.models.find(
    (value) =>
      value.id === state.configuration?.modelId && value.provider === state.configuration?.provider,
  );
  const draft = state.drafts[draftKey(state)] ?? "";
  const images = state.draftImages[draftKey(state)] ?? [];
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
        <TaskStatus label={taskLabel(snapshot)} tone={taskTone(snapshot)} />
      )}
      {snapshot?.sandbox && !snapshot.sandbox.available && (
        <ErrorStrip message={snapshot.sandbox.reason ?? "Bot 沙盒不可用"} />
      )}
      {snapshot?.recoveryRequired && (
        <View style={styles.inlineAction}>
          <Button
            compact
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
        <View style={styles.inlineAction}>
          <Button
            compact
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
          <ConnectionBanner
            reconnecting={state.status === "reconnecting"}
            message={state.error}
            url={state.url}
            busy={busy}
            onReconnect={() => {
              void run(() => store.reconnect());
            }}
            onSettings={() => router.push("/settings")}
          />
        )}
        {connected && state.error && <ErrorStrip message={state.error} />}
        <View style={styles.transcript}>
          <FlatList
            ref={list}
            data={rows}
            keyExtractor={(row) => row.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={[styles.messages, !rows.length && styles.emptyList]}
            renderItem={({ item, index }) =>
              snapshot && tools ? (
                <MessageView
                  message={item.message}
                  snapshot={snapshot}
                  tools={tools}
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
              <ChatEmptyState
                title={
                  state.opening
                    ? "正在读取会话…"
                    : state.threadId && !state.thread
                      ? "会话尚未加载"
                      : "从这里开始工作"
                }
                hint={
                  !state.library?.models.length
                    ? "Bot 尚未提供模型，请先在 Bot 配置模型凭据"
                    : state.thread && !state.opening
                      ? "这个会话还没有消息"
                      : state.threadId
                        ? "连接 Bot 后查看会话内容"
                        : project
                          ? `任务将在 ${project.name} 中运行`
                          : "先选择或创建一个 Bot 项目"
                }
              >
                {state.threadId && !state.thread && !state.opening && (
                  <Button
                    compact
                    secondary
                    disabled={!connected || busy}
                    onPress={() => {
                      void run(() => store.open(state.threadId!));
                    }}
                  >
                    重新加载会话
                  </Button>
                )}
              </ChatEmptyState>
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
          <PendingNotice
            sending={state.sending}
            prompt={state.pending.prompt}
            imageCount={state.pending.images?.length}
            busy={busy}
            connected={connected}
            onRetry={() => {
              void run(() => store.retrySend());
            }}
          />
        )}
        <View style={styles.composerArea}>
          {imageError && <ErrorStrip message={imageError} />}
          <ComposerInput
            images={images}
            onAddImages={() => {
              void selectImages();
            }}
            onRemoveImage={(id) => store.removeImage(id)}
            pickingImages={pickingImages}
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
              !pickingImages &&
              Boolean(draft.trim() || images.length) &&
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
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
  },
  title: { flex: 1, alignItems: "center", gap: 2 },
  titleText: { fontSize: 17, fontWeight: "600", color: colors.text, letterSpacing: -0.2 },
  project: { fontSize: 12, color: colors.muted },
  transcript: { flex: 1 },
  messages: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
  emptyList: { flexGrow: 1 },
  inlineAction: { alignItems: "flex-start", marginVertical: 8 },
  jump: {
    position: "absolute",
    bottom: 14,
    right: 20,
    borderRadius: 20,
  },
  composerArea: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: Platform.OS === "ios" ? 4 : 8,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
});
