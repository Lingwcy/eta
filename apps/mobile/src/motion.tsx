import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import * as RN from "react-native";
import { Pressable, View } from "react-native";
import type { PressableProps, StyleProp, ViewStyle } from "react-native";

const Animated = Object.prototype.hasOwnProperty.call(RN, "Animated") ? RN.Animated : undefined;
const Easing = Object.prototype.hasOwnProperty.call(RN, "Easing") ? RN.Easing : undefined;

type SpringPressableProps = Omit<PressableProps, "style"> & {
  scaleTo?: number;
  style?: PressableProps["style"];
  containerStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
};

const hasAnimatedValue =
  typeof Animated !== "undefined" &&
  typeof Animated?.Value === "function" &&
  Boolean(Animated?.View);

const canAnimateValues =
  hasAnimatedValue &&
  (typeof Animated?.spring === "function" || typeof Animated?.timing === "function");

/** Tactile spring press wrapper using native-driver transforms so interactions feel elastic without idle repaints. */
export function SpringPressable({
  scaleTo = 0.965,
  disabled,
  onPressIn,
  onPressOut,
  style,
  containerStyle,
  children,
  ...rest
}: SpringPressableProps) {
  const scaleRef = useRef<InstanceType<NonNullable<typeof Animated>["Value"]> | null>(null);
  if (hasAnimatedValue && scaleRef.current === null && Animated) {
    scaleRef.current = new Animated.Value(1);
  }
  const scale = scaleRef.current;

  if (!hasAnimatedValue || !Animated || !scale) {
    return (
      <View style={containerStyle}>
        <Pressable
          disabled={disabled}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          style={style}
          {...rest}
        >
          {children}
        </Pressable>
      </View>
    );
  }

  const animateTo = (toValue: number, friction: number, tension: number) => {
    if (typeof Animated.spring === "function") {
      Animated.spring(scale, {
        toValue,
        tension,
        friction,
        useNativeDriver: true,
      })?.start?.();
    } else if (typeof Animated.timing === "function") {
      Animated.timing(scale, {
        toValue,
        duration: 90,
        useNativeDriver: true,
      })?.start?.();
    }
  };

  return (
    <Animated.View style={[containerStyle, { transform: [{ scale }] }]}>
      <Pressable
        disabled={disabled}
        onPressIn={(event) => {
          if (!disabled) animateTo(scaleTo, 20, 340);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          animateTo(1, 15, 280);
          onPressOut?.(event);
        }}
        style={style}
        {...rest}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

/** Smooth one-shot mount entrance (opacity + vertical spring) for cards, messages, and expanded panels. */
export function FadeSlideIn({
  children,
  offset = 6,
  duration = 180,
  style,
}: {
  children: ReactNode;
  offset?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const opacityRef = useRef<InstanceType<NonNullable<typeof Animated>["Value"]> | null>(null);
  const translateYRef = useRef<InstanceType<NonNullable<typeof Animated>["Value"]> | null>(null);
  if (canAnimateValues && Animated) {
    if (opacityRef.current === null) opacityRef.current = new Animated.Value(0);
    if (translateYRef.current === null) translateYRef.current = new Animated.Value(offset);
  }
  const opacity = opacityRef.current;
  const translateY = translateYRef.current;

  useEffect(() => {
    if (!canAnimateValues || !Animated || !opacity || !translateY) return;
    const fade =
      typeof Animated.timing === "function"
        ? Animated.timing(opacity, {
            toValue: 1,
            duration,
            easing: typeof Easing?.out === "function" ? Easing.out(Easing.cubic) : undefined,
            useNativeDriver: true,
          })
        : undefined;
    const slide =
      typeof Animated.spring === "function"
        ? Animated.spring(translateY, {
            toValue: 0,
            tension: 260,
            friction: 24,
            useNativeDriver: true,
          })
        : typeof Animated.timing === "function"
          ? Animated.timing(translateY, {
              toValue: 0,
              duration,
              useNativeDriver: true,
            })
          : undefined;

    if (typeof Animated.parallel === "function" && fade && slide) {
      const anim = Animated.parallel([fade, slide]);
      anim?.start?.();
      return () => anim?.stop?.();
    }
    fade?.start?.();
    slide?.start?.();
  }, [duration, opacity, translateY]);

  if (!canAnimateValues || !Animated || !opacity || !translateY) {
    return <View style={style}>{children}</View>;
  }

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}
