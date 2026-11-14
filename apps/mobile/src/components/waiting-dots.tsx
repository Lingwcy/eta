import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useI18n } from "../i18n/index.ts";
import { colors } from "../ui.tsx";

function PulseDot({ delayMs }: { delayMs: number }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const stepUp = Animated.timing(progress, {
      toValue: 1,
      duration: 380,
      easing: Easing?.out ? Easing.out(Easing.cubic) : undefined,
      useNativeDriver: true,
    });
    const stepDown = Animated.timing(progress, {
      toValue: 0,
      duration: 380,
      easing: Easing?.in ? Easing.in(Easing.cubic) : undefined,
      useNativeDriver: true,
    });
    const pause = Animated.delay(240);
    const loop = Animated.loop(
      Animated.sequence([Animated.delay(delayMs), stepUp, stepDown, pause]),
    );
    loop.start();
    return () => loop.stop();
  }, [delayMs, progress]);

  const opacity = progress.interpolate
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [0.22, 0.88] })
    : 0.55;
  const scale = progress.interpolate
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.1] })
    : 1;

  return <Animated.View style={[styles.dot, { opacity, transform: [{ scale }] }]} />;
}

/** Monochrome 3-dot pulse indicator mounted only while waiting for the first streaming chunk. */
export function WaitingDots() {
  const { m } = useI18n();
  return (
    <View style={styles.row} accessibilityLabel={m.waitingDots.label}>
      <PulseDot delayMs={0} />
      <PulseDot delayMs={150} />
      <PulseDot delayMs={300} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingVertical: 10,
    paddingHorizontal: 2,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.ink,
  },
});
