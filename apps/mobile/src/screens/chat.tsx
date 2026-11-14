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
import { useMobile, useUpdater } from "../provider.tsx";
import { draftKey } from "../bot/store.ts";
import {
  buildToolIndex,
  conversationTurns,
  isWaitingForReply,
  taskLabel,
  type ConversationTurn,
} from "../conversation.ts";
import { MessageView } from "../components/message.tsx";
import { WaitingDots } from "../components/waiting-dots.tsx";
import { Approvals } from "../components/approvals.tsx";
import { getMessages, useI18n } from "../i18n/index.ts";
import {
  ChatEmptyState,
  ConnectionBanner,
  ErrorStrip,
  PendingNotice,
  TaskStatus,
  taskTone,
} from "../components/chat-status.tsx";
import { ConfigurationSheet } from "../components/configuration.tsx";
import { ComposerInput } from "../components/composer-input.tsx";
import { Sidebar } from "../components/sidebar.tsx";
import { BrandSplash } from "../components/splash.tsx";
import { UpdateBanner } from "../components/update-banner.tsx";
import { FadeSlideIn } from "../motion.tsx";
import { Button, colors, common, IconButton, useAction } from "../ui.tsx";
import { SettingsScreen } from "./settings.tsx";

export function ChatScreen() {
  const { state, store } = useMobile();
  const { updater, update } = useUpdater();
  const { m } = useI18n();
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
        setImageError(error instanceof Error ? error.message : getMessages().chat.imagePickFailed);
    } finally {
      pickerBusy.current = false;
      if (mounted.current) setPickingImages(false);
    }
  };
  const { busy, run } = useAction();
  const { busy: stopping, run: stop } = useAction();

  const atBottom = useRef(true);
  const list = useRef<FlatList<ConversationTurn>>(null);
  const snapshot = state.thread?.snapshot;
  const turns = useMemo(
    () =>
      snapshot
        ? conversationTurns(
            snapshot,
            state.submittedInputs.filter((input) => input.threadId === state.threadId),
          )
        : [],
    [snapshot, state.submittedInputs, state.threadId],
  );
  const tools = useMemo(() => (snapshot ? buildToolIndex(snapshot) : undefined), [snapshot]);
  const waitingForReply = isWaitingForReply(snapshot, turns);
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
  const allowed = connected && !busy && !stopping && !state.sending && !state.opening;
  useEffect(() => {
    atBottom.current = true;
    setAway(false);
  }, [state.threadId]);

  if (state.status === "loading")
    return (
      <SafeAreaView style={[common.screen, styles.loading]}>
        <BrandSplash label={m.splash.loadingConnection} />
      </SafeAreaView>
    );
  if (!state.url) return <SettingsScreen onboarding />;

  const statusText = taskLabel(snapshot);
  const statusTone = taskTone(snapshot);
  const showTaskStatus =
    Boolean(statusText) &&
    statusTone !== "done" &&
    !(statusTone === "running" && statusText === m.conversation.running);

  const footer = (
    <>
      {waitingForReply && (
        <View style={styles.waitingRow}>
          <WaitingDots />
        </View>
      )}
      {snapshot && <Approvals snapshot={snapshot} />}
      {showTaskStatus && <TaskStatus label={statusText} tone={statusTone} />}
      {snapshot?.sandbox && !snapshot.sandbox.available && (
        <ErrorStrip message={snapshot.sandbox.reason ?? m.chat.sandboxUnavailable} />
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
            {m.chat.resumeTask}
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
            {m.chat.unarchive}
          </Button>
        </View>
      )}
    </>
  );

  const hasSessionHeader = Boolean(state.thread || turns.length > 0);

  return (
    <SafeAreaView style={common.screen}>
      <KeyboardAvoidingView
        style={common.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          <IconButton
            ghost
            icon={Menu}
            label={m.chat.openSidebarLabel}
            onPress={() => setSidebar(true)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={m.chat.selectProjectOrThreadLabel}
            onPress={() => setSidebar(true)}
            style={styles.title}
          >
            <Text numberOfLines={1} style={styles.titleText}>
              {hasSessionHeader
                ? state.thread?.thread.title || m.chat.newThreadTitle
                : (project?.name ?? m.chat.selectProjectFallback)}
            </Text>
            {hasSessionHeader && project?.name ? (
              <Text numberOfLines={1} style={styles.project}>
                {project.name}
              </Text>
            ) : null}
          </Pressable>
          <IconButton
            ghost
            icon={SquarePen}
            label={m.chat.newChatLabel}
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
        <UpdateBanner update={update} updater={updater} />
        <View style={styles.transcript}>
          <FlatList
            ref={list}
            style={styles.list}
            data={turns}
            keyExtractor={(turn) => `${state.threadId ?? "draft"}:${turn.id}`}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            contentContainerStyle={[styles.messages, !turns.length && styles.emptyList]}
            renderItem={({ item }) =>
              snapshot && tools ? (
                item.role === "assistant" ? (
                  <MessageView messages={item.messages} snapshot={snapshot} tools={tools} />
                ) : (
                  <MessageView message={item.message} snapshot={snapshot} tools={tools} />
                )
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
                60;
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
                    ? m.chat.loadingThreadTitle
                    : state.threadId && !state.thread
                      ? m.chat.unloadedThreadTitle
                      : m.chat.welcomeTitle
                }
                hint={
                  !state.library?.models.length
                    ? m.chat.noModelsHint
                    : state.thread && !state.opening
                      ? m.chat.readyThreadHint
                      : state.threadId
                        ? m.chat.unloadedThreadHint
                        : project
                          ? m.chat.projectTargetHint(project.name)
                          : m.chat.selectProjectHint
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
                    {m.chat.reloadThread}
                  </Button>
                )}
              </ChatEmptyState>
            }
            ListFooterComponent={footer}
          />
          {away && (
            <FadeSlideIn offset={10} duration={160} style={styles.jump}>
              <IconButton
                icon={ArrowDown}
                size={18}
                label={m.chat.scrollBottomLabel}
                onPress={() => {
                  atBottom.current = true;
                  setAway(false);
                  list.current?.scrollToEnd({ animated: true });
                }}
              />
            </FadeSlideIn>
          )}
        </View>
        {state.pending && !state.sending && (
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
            allowSubmitWhileRunning={snapshot?.inputQueueSupported === true}
            onStop={() => {
              void stop(() => store.control("stop"));
            }}
            onOpenConfiguration={() => setConfiguration(true)}
            running={running}
            canStop={
              connected && !state.opening && !stopping && snapshot?.operation?.status !== "aborting"
            }
            canSend={
              allowed &&
              !state.pending &&
              !pickingImages &&
              Boolean(draft.trim() || images.length) &&
              Boolean(workspace) &&
              Boolean(model) &&
              !state.thread?.thread.archivedAt &&
              snapshot?.operation?.status !== "aborting" &&
              (!running || snapshot?.inputQueueSupported === true) &&
              !snapshot?.recoveryRequired &&
              !snapshot?.blockedReason &&
              !snapshot?.faulted
            }
            disabled={!connected || state.opening || !!state.pending}
            modelName={model?.name}
            modelProvider={model?.provider ?? state.configuration?.provider}
            thinkingLevel={state.configuration?.thinkingLevel}
            thinkingLevelLabel={
              state.configuration
                ? m.configuration.thinkingLevels[state.configuration.thinkingLevel]
                : undefined
            }
            sandboxMode={
              state.configuration?.sandboxMode ?? snapshot?.sandbox?.mode ?? "danger-full-access"
            }
            sandboxModeLabel={
              m.configuration.sandboxModes[
                state.configuration?.sandboxMode ?? snapshot?.sandbox?.mode ?? "danger-full-access"
              ]
            }
            onToggleSandbox={() => {
              const currentConfig = state.configuration;
              if (!currentConfig) {
                setConfiguration(true);
                return;
              }
              const allowed = snapshot?.sandbox?.allowedModes ??
                state.library?.allowedSandboxModes ?? [
                  "danger-full-access",
                  "workspace-write",
                  "read-only",
                ];
              if (allowed.length <= 1) {
                setConfiguration(true);
                return;
              }
              const currentMode =
                currentConfig.sandboxMode ?? snapshot?.sandbox?.mode ?? "danger-full-access";
              const index = allowed.indexOf(currentMode);
              const nextMode = allowed[(index + 1) % allowed.length]!;
              void run(() => store.configure({ ...currentConfig, sandboxMode: nextMode }));
            }}
            placeholder={
              state.status !== "connected"
                ? m.chat.disconnectedPlaceholder
                : running
                  ? m.chat.runningPlaceholder
                  : m.chat.defaultPlaceholder
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
    height: 54,
    paddingHorizontal: 8,
    backgroundColor: colors.background,
  },
  title: {
    flex: 1,
    minWidth: 0,
    marginHorizontal: 6,
    justifyContent: "center",
  },
  titleText: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "600",
    letterSpacing: -0.2,
    color: colors.text,
  },
  project: {
    fontSize: 11.5,
    lineHeight: 15,
    color: colors.muted,
  },
  transcript: { flex: 1, minHeight: 0 },
  list: { flex: 1 },
  messages: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 20,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
  },
  emptyList: { flexGrow: 1 },
  waitingRow: {
    marginBottom: 12,
  },
  inlineAction: { alignItems: "flex-start", marginVertical: 8 },
  jump: {
    position: "absolute",
    bottom: 14,
    right: 18,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    ...Platform.select({
      ios: {
        shadowColor: "#000000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  composerArea: {
    paddingHorizontal: 14,
    paddingTop: 4,
    paddingBottom: Platform.OS === "ios" ? 6 : 10,
    maxWidth: 760,
    width: "100%",
    alignSelf: "center",
    backgroundColor: colors.background,
  },
});
