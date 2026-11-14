import { useState } from "react";
import { useRouter } from "expo-router";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  Compass,
  Download,
  Eye,
  EyeOff,
  Power,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  isValidBotUrl,
  OnboardingWizard,
  prepareBotUrl,
  withScheme,
} from "../components/onboarding.tsx";
import { FadeSlideIn, SpringPressable } from "../motion.tsx";
import { useMobile, useUpdater } from "../provider.tsx";
import { getMessages, localeLabels, SUPPORTED_LOCALES, useI18n } from "../i18n/index.ts";
import { colors, radii, useAction } from "../ui.tsx";
import type { UpdateSnapshot } from "../updater.ts";

function describeUpdateStatus(update: UpdateSnapshot, m: ReturnType<typeof useI18n>["m"]) {
  const { state } = update;
  switch (state.status) {
    case "idle":
      return m.updates.idleStatus;
    case "checking":
      return m.updates.checkingStatus;
    case "not-available":
      return m.updates.upToDateStatus;
    case "available":
      return m.updates.availableStatus(state.release.version);
    case "downloading":
      return m.updates.downloadingStatus(state.release.version, state.percent);
    case "downloaded":
      return m.updates.downloadedStatus(state.release.version);
    case "permission-required":
      return m.updates.permissionRequiredStatus(state.release.version);
    case "error":
      return m.updates.errorStatus(state.message);
  }
}

function statusMeta(status: string) {
  const { settings } = getMessages();
  if (status === "connected") return { label: settings.statusConnected, color: colors.success };
  if (status === "connecting" || status === "reconnecting") {
    return { label: settings.statusConnecting, color: colors.warning };
  }
  return { label: settings.statusUnavailable, color: colors.danger };
}

export function SettingsScreen({ onboarding = false }: { onboarding?: boolean }) {
  const { store, state } = useMobile();
  const { updater, update } = useUpdater();
  const { m, locale, setLocale } = useI18n();
  const router = useRouter();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [url, setUrl] = useState(state.url ?? "");
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [urlFocused, setUrlFocused] = useState(false);
  const [tokenFocused, setTokenFocused] = useState(false);
  const { busy, run } = useAction();

  const connect = (target?: { url: string; token: string }) =>
    run(async () => {
      const nextUrl = prepareBotUrl(target?.url ?? url);
      const nextToken = (target?.token ?? token).trim();
      await store.connect({ url: nextUrl, token: nextToken });
      setUrl(nextUrl);
      setToken("");
      setWizardOpen(false);
      if (!onboarding && router.canGoBack()) router.back();
    });

  const confirmClear = () =>
    Alert.alert(m.settings.clearAlertTitle, m.settings.clearAlertBody, [
      { text: m.common.cancel, style: "cancel" },
      {
        text: m.settings.clearConfirm,
        style: "destructive",
        onPress: () => {
          void run(async () => {
            await store.disconnect(true);
            setUrl("");
            setToken("");
          });
        },
      },
    ]);

  if (onboarding || !state.url || wizardOpen) {
    return (
      <OnboardingWizard
        initialUrl={state.url ?? url}
        initialStep={wizardOpen && state.url ? 1 : 0}
        error={state.error}
        busy={busy || state.sending}
        onClose={!onboarding && state.url ? () => setWizardOpen(false) : undefined}
        onConnect={(connection) => connect(connection)}
      />
    );
  }

  const blocked = busy || state.sending;
  const canConnect = !blocked && isValidBotUrl(url) && Boolean(token.trim());
  const status = statusMeta(state.status);
  const workspaceCount = state.library?.workspaces.length ?? 0;
  const modelCount = state.library?.models.length ?? 0;

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.header}>
          <SpringPressable
            scaleTo={0.92}
            accessibilityRole="button"
            accessibilityLabel={m.settings.returnChatLabel}
            hitSlop={8}
            onPress={() => router.back()}
            style={styles.iconCircle}
          >
            <ArrowLeft size={17} strokeWidth={2} color={colors.ink} />
          </SpringPressable>

          <Text numberOfLines={1} style={styles.headerTitle}>
            {m.settings.title}
          </Text>

          <SpringPressable
            scaleTo={0.95}
            accessibilityRole="button"
            accessibilityLabel={m.settings.openGuideLabel}
            onPress={() => setWizardOpen(true)}
            style={styles.guideBtn}
          >
            <Compass size={13} strokeWidth={2} color={colors.ink} />
            <Text style={styles.guideBtnText}>{m.settings.openGuide}</Text>
          </SpringPressable>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <FadeSlideIn offset={8} duration={200} style={styles.statusCard}>
            <View style={styles.statusTopRow}>
              <View style={styles.statusIconWrap}>
                <Server size={18} strokeWidth={1.9} color={colors.ink} />
              </View>
              <View style={styles.statusMeta}>
                <View style={styles.statusPillRow}>
                  <View style={[styles.statusDot, { backgroundColor: status.color }]} />
                  <Text style={styles.statusTitle}>{status.label}</Text>
                </View>
                <Text numberOfLines={1} selectable style={styles.statusUrl}>
                  {state.url}
                </Text>
              </View>
            </View>

            {state.library ? (
              <Text style={styles.statusSummary}>
                {m.settings.syncedSummary(workspaceCount, modelCount)}
              </Text>
            ) : null}

            <View style={styles.quickActionRow}>
              <SpringPressable
                scaleTo={0.96}
                accessibilityRole="button"
                accessibilityLabel={m.settings.reconnect}
                disabled={blocked}
                onPress={() => {
                  void run(() => store.reconnect());
                }}
                containerStyle={styles.quickActionWrap}
                style={[styles.quickBtn, blocked && styles.disabled]}
              >
                <RefreshCw size={14} strokeWidth={2} color={colors.ink} />
                <Text style={styles.quickBtnText}>{m.settings.reconnect}</Text>
              </SpringPressable>

              <SpringPressable
                scaleTo={0.96}
                accessibilityRole="button"
                accessibilityLabel={m.settings.disconnect}
                disabled={blocked}
                onPress={() => {
                  void run(() => store.disconnect());
                }}
                containerStyle={styles.quickActionWrap}
                style={[styles.quickBtn, blocked && styles.disabled]}
              >
                <Power size={14} strokeWidth={2} color={colors.ink} />
                <Text style={styles.quickBtnText}>{m.settings.disconnect}</Text>
              </SpringPressable>
            </View>
          </FadeSlideIn>

          <Text style={styles.sectionLabel}>{m.settings.replaceSectionTitle}</Text>

          <View style={styles.formCard}>
            <View style={[styles.fieldBox, urlFocused && styles.fieldBoxFocused]}>
              <Text style={styles.fieldLabel}>BOT URL</Text>
              <TextInput
                accessibilityLabel={m.onboarding.urlInputLabel}
                value={url}
                onChangeText={setUrl}
                onFocus={() => setUrlFocused(true)}
                onBlur={() => setUrlFocused(false)}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://bot.example.com"
                placeholderTextColor={colors.caption}
                selectionColor={colors.ink}
                style={styles.input}
              />
              <View style={styles.schemeRow}>
                {(["https://", "http://"] as const).map((scheme) => {
                  const active = url.trim().toLowerCase().startsWith(scheme);
                  return (
                    <Pressable
                      key={scheme}
                      accessibilityRole="button"
                      accessibilityLabel={m.onboarding.useSchemeLabel(scheme)}
                      onPress={() => setUrl(withScheme(url, scheme))}
                      style={({ pressed }) => [
                        styles.schemeChip,
                        active && styles.schemeChipActive,
                        pressed && styles.pressedSoft,
                      ]}
                    >
                      <Text style={[styles.schemeText, active && styles.schemeTextActive]}>
                        {scheme}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={[styles.fieldBox, tokenFocused && styles.fieldBoxFocused]}>
              <View style={styles.fieldLabelRow}>
                <Text style={styles.fieldLabel}>ACCESS TOKEN</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    visible ? m.onboarding.hideTokenLabel : m.onboarding.showTokenLabel
                  }
                  hitSlop={8}
                  onPress={() => setVisible((prev) => !prev)}
                  style={styles.eyeBtn}
                >
                  {visible ? (
                    <EyeOff size={15} strokeWidth={1.9} color={colors.muted} />
                  ) : (
                    <Eye size={15} strokeWidth={1.9} color={colors.muted} />
                  )}
                </Pressable>
              </View>
              <TextInput
                accessibilityLabel={m.onboarding.tokenInputLabel}
                value={token}
                onChangeText={setToken}
                onFocus={() => setTokenFocused(true)}
                onBlur={() => setTokenFocused(false)}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!visible}
                placeholder={m.settings.tokenUpdatePlaceholder}
                placeholderTextColor={colors.caption}
                selectionColor={colors.ink}
                style={styles.input}
              />
            </View>

            {state.error ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {state.error}
              </Text>
            ) : null}

            <SpringPressable
              scaleTo={0.97}
              accessibilityRole="button"
              accessibilityLabel={m.settings.verifyConnect}
              disabled={!canConnect}
              onPress={() => {
                void connect();
              }}
              style={[styles.submitBtn, !canConnect && styles.submitBtnDisabled]}
            >
              <Text style={[styles.submitText, !canConnect && styles.submitTextDisabled]}>
                {busy ? m.settings.verifying : m.settings.verifyConnect}
              </Text>
            </SpringPressable>
          </View>

          <Text style={styles.sectionLabel}>{m.settings.languageSectionTitle}</Text>
          <View
            style={styles.langCard}
            accessibilityRole="radiogroup"
            accessibilityLabel={m.settings.languageSectionTitle}
          >
            {SUPPORTED_LOCALES.map((item) => {
              const active = item === locale;
              return (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={localeLabels[item].native}
                  onPress={() => setLocale(item)}
                  style={({ pressed }) => [
                    styles.langOption,
                    active && styles.langOptionActive,
                    pressed && styles.pressedSoft,
                  ]}
                >
                  <Text style={[styles.langOptionText, active && styles.langOptionTextActive]}>
                    {localeLabels[item].native}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.sectionLabel}>{m.updates.sectionTitle}</Text>
          <View style={styles.updateCard}>
            <View style={styles.updateTopRow}>
              <View style={styles.updateMeta}>
                <Text style={styles.updateVersion}>
                  {m.updates.versionLabel(update.currentVersion)}
                </Text>
                <Text style={styles.updateStatusText}>{describeUpdateStatus(update, m)}</Text>
              </View>
              <View style={styles.updateActions}>
                {update.state.status === "downloading" ? (
                  <SpringPressable
                    scaleTo={0.96}
                    accessibilityRole="button"
                    accessibilityLabel={m.updates.cancelAction}
                    onPress={() => updater.cancelDownload()}
                    style={styles.updateBtnOutline}
                  >
                    <Text style={styles.updateBtnOutlineText}>{m.updates.cancelAction}</Text>
                  </SpringPressable>
                ) : update.state.status === "downloaded" ? (
                  <SpringPressable
                    scaleTo={0.96}
                    accessibilityRole="button"
                    accessibilityLabel={m.updates.installAction}
                    onPress={() => {
                      void updater.install();
                    }}
                    style={styles.updateBtnPrimary}
                  >
                    <Text style={styles.updateBtnPrimaryText}>{m.updates.installAction}</Text>
                  </SpringPressable>
                ) : update.state.status === "permission-required" ? (
                  <SpringPressable
                    scaleTo={0.96}
                    accessibilityRole="button"
                    accessibilityLabel={m.updates.allowPermissionAction}
                    onPress={() => {
                      void updater.requestInstallPermission();
                    }}
                    style={styles.updateBtnPrimary}
                  >
                    <Text style={styles.updateBtnPrimaryText}>
                      {m.updates.allowPermissionAction}
                    </Text>
                  </SpringPressable>
                ) : update.state.status === "available" ? (
                  <SpringPressable
                    scaleTo={0.96}
                    accessibilityRole="button"
                    accessibilityLabel={
                      update.supportsInAppInstall
                        ? m.updates.downloadAction
                        : m.updates.openDownloadAction
                    }
                    onPress={() => {
                      void updater.downloadAndInstall();
                    }}
                    style={styles.updateBtnPrimary}
                  >
                    <Download size={13} strokeWidth={2} color={colors.surface} />
                    <Text style={styles.updateBtnPrimaryText}>
                      {update.supportsInAppInstall
                        ? m.updates.downloadAction
                        : m.updates.openDownloadAction}
                    </Text>
                  </SpringPressable>
                ) : (
                  <SpringPressable
                    scaleTo={0.96}
                    accessibilityRole="button"
                    accessibilityLabel={m.updates.checkAction}
                    disabled={update.state.status === "checking"}
                    onPress={() => {
                      void updater.check(true);
                    }}
                    style={[
                      styles.updateBtnOutline,
                      update.state.status === "checking" && styles.disabled,
                    ]}
                  >
                    <Text style={styles.updateBtnOutlineText}>
                      {update.state.status === "checking"
                        ? m.updates.checkingAction
                        : m.updates.checkAction}
                    </Text>
                  </SpringPressable>
                )}
              </View>
            </View>

            {update.state.status === "downloading" && (
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${update.state.percent}%` }]} />
              </View>
            )}

            {update.state.status === "error" && (
              <View style={styles.updateErrorActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={m.updates.openReleasesAction}
                  onPress={() => {
                    void updater.openReleasePage();
                  }}
                  style={({ pressed }) => [styles.updateBtnOutline, pressed && styles.pressedSoft]}
                >
                  <Text style={styles.updateBtnOutlineText}>{m.updates.openReleasesAction}</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.updateDivider} />

            <View style={styles.autoCheckRow}>
              <Text style={styles.autoCheckLabel}>{m.updates.autoCheckTitle}</Text>
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: update.autoCheck }}
                accessibilityLabel={m.updates.autoCheckTitle}
                onPress={() => updater.setAutoCheck(!update.autoCheck)}
                style={({ pressed }) => [
                  styles.autoCheckPill,
                  update.autoCheck && styles.autoCheckPillActive,
                  pressed && styles.pressedSoft,
                ]}
              >
                <Text
                  style={[
                    styles.autoCheckPillText,
                    update.autoCheck && styles.autoCheckPillTextActive,
                  ]}
                >
                  {update.autoCheck ? m.updates.enabled : m.updates.disabled}
                </Text>
              </Pressable>
            </View>
          </View>

          <SpringPressable
            scaleTo={0.98}
            accessibilityRole="button"
            accessibilityLabel={m.settings.clearAll}
            disabled={blocked}
            onPress={confirmClear}
            style={[styles.dangerBtn, blocked && styles.disabled]}
          >
            <Trash2 size={15} strokeWidth={2} color={colors.danger} />
            <Text style={styles.dangerText}>{m.settings.clearAll}</Text>
          </SpringPressable>

          <Text style={styles.footnote}>{m.settings.footnote}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 6,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: -0.3,
    color: colors.ink,
  },
  guideBtn: {
    height: 32,
    paddingHorizontal: 11,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  guideBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.ink,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 36,
    maxWidth: 540,
    width: "100%",
    alignSelf: "center",
  },
  statusCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSubtle,
    padding: 16,
  },
  statusTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  statusMeta: {
    flex: 1,
    minWidth: 0,
  },
  statusPillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statusTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.ink,
  },
  statusUrl: {
    marginTop: 2,
    fontSize: 12.5,
    color: colors.muted,
  },
  statusSummary: {
    marginTop: 12,
    fontSize: 12,
    color: colors.secondary,
  },
  quickActionRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },
  quickActionWrap: {
    flex: 1,
  },
  quickBtn: {
    height: 38,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  quickBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.ink,
  },
  sectionLabel: {
    marginTop: 24,
    marginBottom: 10,
    paddingHorizontal: 2,
    fontSize: 12,
    fontWeight: "600",
    color: colors.muted,
  },
  formCard: {
    gap: 10,
  },
  fieldBox: {
    borderRadius: 16,
    borderWidth: 1.2,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  fieldBoxFocused: {
    borderColor: colors.ink,
  },
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  fieldLabel: {
    marginBottom: 4,
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 1.1,
    color: colors.muted,
  },
  input: {
    minHeight: 26,
    padding: 0,
    fontSize: 15.5,
    lineHeight: 21,
    color: colors.ink,
  },
  schemeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
    paddingTop: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  schemeChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
  },
  schemeChipActive: {
    backgroundColor: colors.ink,
  },
  schemeText: {
    fontSize: 11.5,
    fontWeight: "600",
    color: colors.secondary,
  },
  schemeTextActive: {
    color: colors.surface,
  },
  eyeBtn: {
    width: 26,
    height: 26,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  errorText: {
    paddingHorizontal: 4,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.danger,
  },
  submitBtn: {
    marginTop: 4,
    height: 46,
    borderRadius: radii.full,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnDisabled: {
    backgroundColor: colors.soft,
    borderWidth: 1,
    borderColor: colors.border,
  },
  submitText: {
    fontSize: 14.5,
    fontWeight: "600",
    color: colors.surface,
  },
  submitTextDisabled: {
    color: colors.caption,
  },
  dangerBtn: {
    marginTop: 22,
    height: 46,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.dangerBorder,
    backgroundColor: colors.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  dangerText: {
    fontSize: 13.5,
    fontWeight: "600",
    color: colors.danger,
  },
  footnote: {
    marginTop: 12,
    paddingHorizontal: 4,
    fontSize: 11.5,
    lineHeight: 17,
    color: colors.muted,
  },
  langCard: {
    flexDirection: "row",
    gap: 8,
    padding: 6,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  langOption: {
    flex: 1,
    minHeight: 38,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.soft,
  },
  langOptionActive: {
    backgroundColor: colors.ink,
  },
  langOptionText: {
    fontSize: 13,
    fontWeight: "500",
    color: colors.secondary,
  },
  langOptionTextActive: {
    color: colors.surface,
    fontWeight: "600",
  },
  updateCard: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: 14,
    gap: 10,
  },
  updateTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  updateMeta: {
    flex: 1,
    gap: 2,
  },
  updateVersion: {
    fontSize: 13.5,
    fontWeight: "600",
    color: colors.ink,
  },
  updateStatusText: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.muted,
  },
  updateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  updateBtnPrimary: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: radii.full,
    backgroundColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  updateBtnPrimaryText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.surface,
  },
  updateBtnOutline: {
    minHeight: 32,
    paddingHorizontal: 12,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  updateBtnOutlineText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.ink,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.soft,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.ink,
  },
  updateErrorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  updateDivider: {
    height: 1,
    backgroundColor: colors.border,
  },
  autoCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  autoCheckLabel: {
    flex: 1,
    fontSize: 13,
    fontWeight: "500",
    color: colors.text,
  },
  autoCheckPill: {
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  autoCheckPillActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  autoCheckPillText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.secondary,
  },
  autoCheckPillTextActive: {
    color: colors.surface,
  },
  disabled: {
    opacity: 0.45,
  },
  pressedSoft: {
    opacity: 0.72,
  },
});
