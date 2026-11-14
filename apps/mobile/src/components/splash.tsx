import { Image, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import splashMark from "../../assets/splash-icon.png";
import { colors } from "../theme.ts";
import { useI18n } from "../i18n/index.ts";

const markSource = typeof splashMark === "string" ? { uri: splashMark } : splashMark;

/**
 * Monochrome flat Eta loading view shown only if connection restoration outlasts the native splash.
 * Avoids entrance bounce or duplicate overlay transitions so the app logo never appears twice on launch.
 */
export function BrandSplash({ label }: { label?: string }) {
  const { m } = useI18n();
  const displayLabel = label ?? m.splash.wakingWorkspace;
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
          paddingBottom: Math.max(28, insets.bottom + 18),
        },
      ]}
    >
      <View style={styles.centerStage}>
        <View style={styles.emblemBezel}>
          <View style={styles.markFrame}>
            <Image
              source={markSource}
              accessibilityLabel={m.splash.brandAlt}
              resizeMode="contain"
              style={styles.markImage}
            />
          </View>
        </View>

        <View style={styles.lockup}>
          <Text style={styles.wordmark}>eta</Text>
          <Text style={styles.descriptor}>CODING AGENT</Text>
        </View>
      </View>

      <View style={[styles.footer, { bottom: Math.max(28, insets.bottom + 18) }]}>
        <Text style={styles.statusLabel}>{displayLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  centerStage: {
    alignItems: "center",
    paddingBottom: 28,
  },
  emblemBezel: {
    width: 104,
    height: 104,
    borderRadius: 27,
    backgroundColor: colors.surfaceSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  markFrame: {
    width: 82,
    height: 82,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: colors.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  markImage: {
    width: 82,
    height: 82,
  },
  lockup: {
    alignItems: "center",
    marginTop: 22,
  },
  wordmark: {
    fontSize: 23,
    lineHeight: 28,
    fontWeight: "600",
    letterSpacing: -0.7,
    color: colors.ink,
  },
  descriptor: {
    marginTop: 5,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: "600",
    letterSpacing: 2.6,
    color: colors.caption,
  },
  footer: {
    position: "absolute",
    left: 24,
    right: 24,
    alignItems: "center",
  },
  statusLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: colors.muted,
    letterSpacing: 0.2,
  },
});
