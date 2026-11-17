import { Pressable, StyleSheet, Text, View } from "react-native";
import { ArrowDownToLine, X } from "lucide-react-native";
import { useI18n } from "../i18n/index.ts";
import { SpringPressable } from "../motion.tsx";
import { colors, radii } from "../ui.tsx";
import type { MobileUpdater, UpdateSnapshot } from "../updater.ts";

export function shouldShowUpdateBanner(update: UpdateSnapshot): boolean {
  const { state, dismissedVersion } = update;
  if (
    state.status === "downloading" ||
    state.status === "downloaded" ||
    state.status === "permission-required"
  ) {
    return true;
  }
  if (state.status === "available") {
    return dismissedVersion !== state.release.version;
  }
  return false;
}

export function UpdateBanner({
  update,
  updater,
}: {
  update: UpdateSnapshot;
  updater: MobileUpdater;
}) {
  const { m } = useI18n();
  if (!shouldShowUpdateBanner(update)) return null;

  const { state } = update;
  let title = "";
  let actionLabel = "";
  let onAction: () => void = () => {};
  let canDismiss = true;

  if (state.status === "available") {
    title = m.updates.bannerAvailable(state.release.version);
    actionLabel = update.supportsInAppInstall
      ? m.updates.downloadAction
      : m.updates.openDownloadAction;
    onAction = () => {
      void updater.downloadAndInstall();
    };
  } else if (state.status === "downloading") {
    title = m.updates.bannerDownloading(state.release.version, state.percent);
    actionLabel = m.updates.cancelAction;
    onAction = () => updater.cancelDownload();
    canDismiss = false;
  } else if (state.status === "downloaded") {
    title = m.updates.bannerDownloaded(state.release.version);
    actionLabel = m.updates.installAction;
    onAction = () => {
      void updater.install();
    };
  } else if (state.status === "permission-required") {
    title = m.updates.bannerPermission;
    actionLabel = m.updates.allowPermissionAction;
    onAction = () => {
      void updater.requestInstallPermission();
    };
  } else {
    return null;
  }

  return (
    <View style={styles.banner}>
      <View style={styles.left}>
        <View style={styles.iconWrap}>
          <ArrowDownToLine size={14} strokeWidth={2} color={colors.ink} />
        </View>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
      </View>

      <View style={styles.actions}>
        <SpringPressable
          scaleTo={0.95}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={[styles.actionBtn, state.status === "downloading" && styles.actionBtnSecondary]}
        >
          <Text
            style={[
              styles.actionText,
              state.status === "downloading" && styles.actionTextSecondary,
            ]}
          >
            {actionLabel}
          </Text>
        </SpringPressable>

        {canDismiss && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={m.updates.dismissBannerLabel}
            hitSlop={8}
            onPress={() => updater.dismissBanner()}
            style={({ pressed }) => [styles.dismissBtn, pressed && styles.dismissPressed]}
          >
            <X size={14} strokeWidth={2} color={colors.muted} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 14,
    marginTop: 6,
    marginBottom: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.soft,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    fontSize: 12.5,
    fontWeight: "600",
    color: colors.ink,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  actionBtn: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: radii.full,
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  actionBtnSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionText: {
    fontSize: 11.5,
    fontWeight: "600",
    color: colors.surface,
  },
  actionTextSecondary: {
    color: colors.ink,
  },
  dismissBtn: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  dismissPressed: {
    opacity: 0.6,
  },
});
