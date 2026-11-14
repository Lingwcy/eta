import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Animated as RNAnimated,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as RN from "react-native";
import { ArrowLeft, ArrowRight, Eye, EyeOff, Globe, X } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import onboardingHero from "../../assets/onboarding-hero.png";
import onboardingKey from "../../assets/onboarding-key.png";
import onboardingNode from "../../assets/onboarding-node.png";
import { FadeSlideIn, SpringPressable } from "../motion.tsx";
import { SUPPORTED_LOCALES, localeLabels, useI18n } from "../i18n/index.ts";
import { colors, radii } from "../theme.ts";

const Animated = Object.prototype.hasOwnProperty.call(RN, "Animated") ? RN.Animated : undefined;
const Easing = Object.prototype.hasOwnProperty.call(RN, "Easing") ? RN.Easing : undefined;

const canAnimate =
  typeof Animated !== "undefined" &&
  typeof Animated?.Value === "function" &&
  Boolean(Animated?.View) &&
  typeof Animated?.timing === "function";

const asImageSource = (asset: number | string) =>
  typeof asset === "string" ? { uri: asset } : asset;

const heroSource = asImageSource(onboardingHero);
const nodeSource = asImageSource(onboardingNode);
const keySource = asImageSource(onboardingKey);

/** Normalizes user-entered Bot host/URL into an HTTP/HTTPS origin when possible. */
export function prepareBotUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Applies an explicit http:// or https:// prefix while preserving the current host path. */
export function withScheme(raw: string, scheme: "http://" | "https://"): string {
  const trimmed = raw.trim().replace(/^https?:\/\//i, "");
  return `${scheme}${trimmed}`;
}

/** Checks whether a prepared Bot URL passes BotClient's HTTP/HTTPS origin rules. */
export function isValidBotUrl(raw: string): boolean {
  const candidate = prepareBotUrl(raw);
  if (!candidate) return false;
  try {
    const parsed = new URL(candidate);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

/** Parallax hero stage: scales and glides artwork cleanly on each step transition. */
function ArtworkStage({
  stepKey,
  direction,
  size,
  source,
  label,
}: {
  stepKey: number;
  direction: 1 | -1;
  size: number;
  source: ReturnType<typeof asImageSource>;
  label: string;
}) {
  const opacityRef = useRef<InstanceType<typeof RNAnimated.Value> | null>(null);
  const translateXRef = useRef<InstanceType<typeof RNAnimated.Value> | null>(null);
  const scaleRef = useRef<InstanceType<typeof RNAnimated.Value> | null>(null);

  if (canAnimate && Animated) {
    if (opacityRef.current === null) opacityRef.current = new Animated.Value(0);
    if (translateXRef.current === null) {
      translateXRef.current = new Animated.Value(direction * 32);
    }
    if (scaleRef.current === null) scaleRef.current = new Animated.Value(0.92);
  }

  const opacity = opacityRef.current;
  const translateX = translateXRef.current;
  const scale = scaleRef.current;

  useEffect(() => {
    if (!canAnimate || !Animated || !opacity || !translateX || !scale) return;
    opacity.setValue(0);
    translateX.setValue(direction * 32);
    scale.setValue(0.92);

    const cubicOut = typeof Easing?.out === "function" ? Easing.out(Easing.cubic) : undefined;
    const anims = [
      Animated.timing(opacity, {
        toValue: 1,
        duration: 240,
        easing: cubicOut,
        useNativeDriver: true,
      }),
      typeof Animated.spring === "function"
        ? Animated.spring(translateX, {
            toValue: 0,
            tension: 210,
            friction: 22,
            useNativeDriver: true,
          })
        : Animated.timing(translateX, {
            toValue: 0,
            duration: 240,
            easing: cubicOut,
            useNativeDriver: true,
          }),
      typeof Animated.spring === "function"
        ? Animated.spring(scale, {
            toValue: 1,
            tension: 200,
            friction: 20,
            useNativeDriver: true,
          })
        : Animated.timing(scale, {
            toValue: 1,
            duration: 240,
            easing: cubicOut,
            useNativeDriver: true,
          }),
    ];

    if (typeof Animated.parallel === "function") {
      const anim = Animated.parallel(anims);
      anim?.start?.();
      return () => anim?.stop?.();
    }
    for (const anim of anims) anim?.start?.();
  }, [direction, opacity, scale, stepKey, translateX]);

  const image = (
    <Image
      source={source}
      accessibilityLabel={label}
      resizeMode="contain"
      style={{ width: size, height: size }}
    />
  );

  if (!canAnimate || !Animated || !opacity || !translateX || !scale) {
    return <View style={styles.artWrap}>{image}</View>;
  }

  return (
    <Animated.View style={[styles.artWrap, { opacity, transform: [{ translateX }, { scale }] }]}>
      {image}
    </Animated.View>
  );
}

/** Directional slide+fade transition for step typography and inputs. */
function CopyStage({
  stepKey,
  direction,
  children,
}: {
  stepKey: number;
  direction: 1 | -1;
  children: ReactNode;
}) {
  const opacityRef = useRef<InstanceType<typeof RNAnimated.Value> | null>(null);
  const translateXRef = useRef<InstanceType<typeof RNAnimated.Value> | null>(null);
  const translateYRef = useRef<InstanceType<typeof RNAnimated.Value> | null>(null);

  if (canAnimate && Animated) {
    if (opacityRef.current === null) opacityRef.current = new Animated.Value(0);
    if (translateXRef.current === null) {
      translateXRef.current = new Animated.Value(direction * 18);
    }
    if (translateYRef.current === null) translateYRef.current = new Animated.Value(6);
  }

  const opacity = opacityRef.current;
  const translateX = translateXRef.current;
  const translateY = translateYRef.current;

  useEffect(() => {
    if (!canAnimate || !Animated || !opacity || !translateX || !translateY) return;
    opacity.setValue(0);
    translateX.setValue(direction * 18);
    translateY.setValue(6);

    const cubicOut = typeof Easing?.out === "function" ? Easing.out(Easing.cubic) : undefined;
    const anims = [
      Animated.timing(opacity, {
        toValue: 1,
        duration: 210,
        easing: cubicOut,
        useNativeDriver: true,
      }),
      typeof Animated.spring === "function"
        ? Animated.spring(translateX, {
            toValue: 0,
            tension: 240,
            friction: 24,
            useNativeDriver: true,
          })
        : Animated.timing(translateX, {
            toValue: 0,
            duration: 210,
            easing: cubicOut,
            useNativeDriver: true,
          }),
      typeof Animated.spring === "function"
        ? Animated.spring(translateY, {
            toValue: 0,
            tension: 240,
            friction: 24,
            useNativeDriver: true,
          })
        : Animated.timing(translateY, {
            toValue: 0,
            duration: 210,
            easing: cubicOut,
            useNativeDriver: true,
          }),
    ];

    if (typeof Animated.parallel === "function") {
      const anim = Animated.parallel(anims);
      anim?.start?.();
      return () => anim?.stop?.();
    }
    for (const anim of anims) anim?.start?.();
  }, [direction, opacity, stepKey, translateX, translateY]);

  if (!canAnimate || !Animated || !opacity || !translateX || !translateY) {
    return <View style={styles.copyStage}>{children}</View>;
  }

  return (
    <Animated.View
      style={[styles.copyStage, { opacity, transform: [{ translateX }, { translateY }] }]}
    >
      {children}
    </Animated.View>
  );
}

function StepDots({ step, total }: { step: number; total: number }) {
  const { m } = useI18n();
  return (
    <View style={styles.dotsRow} accessibilityLabel={m.common.stepProgress(step + 1, total)}>
      {Array.from({ length: total }).map((_, index) => {
        const active = index === step;
        const passed = index < step;
        return (
          <View
            key={index}
            style={[styles.dot, active && styles.dotActive, passed && styles.dotPassed]}
          />
        );
      })}
    </View>
  );
}

export interface OnboardingWizardProps {
  initialUrl?: string;
  initialStep?: number;
  error?: string;
  busy?: boolean;
  onClose?: () => void;
  onConnect: (connection: { url: string; token: string }) => Promise<void>;
}

/** Ultra-minimalist visual-first 3-step animated Onboarding flow for Bot pairing. */
export function OnboardingWizard({
  initialUrl = "",
  initialStep = 0,
  error,
  busy = false,
  onClose,
  onConnect,
}: OnboardingWizardProps) {
  const { m, locale, setLocale } = useI18n();
  const [step, setStep] = useState(initialStep);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState("");
  const [visible, setVisible] = useState(false);
  const [urlFocused, setUrlFocused] = useState(false);
  const [tokenFocused, setTokenFocused] = useState(false);

  const normalizedUrl = prepareBotUrl(url);
  const urlValid = isValidBotUrl(url);
  const needsAutoScheme = url.trim().length > 0 && !/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(url.trim());
  const canSubmit = !busy && urlValid && Boolean(token.trim());

  const goTo = (next: number) => {
    setDirection(next >= step ? 1 : -1);
    setStep(next);
  };

  const advanceToToken = () => {
    if (!urlValid) return;
    if (needsAutoScheme) setUrl(normalizedUrl);
    goTo(2);
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    void onConnect({ url: normalizedUrl, token: token.trim() });
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.topBar}>
          <View style={styles.topSide}>
            {step > 0 ? (
              <SpringPressable
                scaleTo={0.92}
                accessibilityRole="button"
                accessibilityLabel={m.onboarding.backLabel}
                hitSlop={8}
                disabled={busy}
                onPress={() => goTo(step - 1)}
                style={styles.circleBtn}
              >
                <ArrowLeft size={17} strokeWidth={2} color={colors.ink} />
              </SpringPressable>
            ) : onClose ? (
              <SpringPressable
                scaleTo={0.92}
                accessibilityRole="button"
                accessibilityLabel={m.onboarding.returnManageLabel}
                hitSlop={8}
                disabled={busy}
                onPress={onClose}
                style={styles.circleBtn}
              >
                <X size={17} strokeWidth={2} color={colors.ink} />
              </SpringPressable>
            ) : null}
          </View>

          <StepDots step={step} total={3} />

          <View style={[styles.topSide, styles.topSideRight]}>
            {step === 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={m.onboarding.skipLabel}
                hitSlop={8}
                onPress={() => goTo(1)}
                style={({ pressed }) => [styles.skipBtn, pressed && styles.pressed]}
              >
                <Text style={styles.skipText}>{m.onboarding.skipText}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {step === 0 && (
            <View style={styles.heroLayout}>
              <ArtworkStage
                stepKey={0}
                direction={direction}
                size={248}
                source={heroSource}
                label={m.onboarding.heroArtLabel}
              />
              <CopyStage stepKey={0} direction={direction}>
                <Text style={styles.heroTitle}>{m.onboarding.heroTitle}</Text>
                <Text style={styles.heroSub}>{m.onboarding.heroSub}</Text>
                <View
                  style={styles.langRow}
                  accessibilityRole="radiogroup"
                  accessibilityLabel={m.onboarding.languageLabel}
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
                          styles.langChip,
                          active && styles.langChipActive,
                          pressed && styles.langChipPressed,
                        ]}
                      >
                        <Text style={[styles.langChipText, active && styles.langChipTextActive]}>
                          {localeLabels[item].native}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </CopyStage>
            </View>
          )}

          {step === 1 && (
            <View style={styles.formLayout}>
              <ArtworkStage
                stepKey={1}
                direction={direction}
                size={188}
                source={nodeSource}
                label={m.onboarding.nodeArtLabel}
              />
              <CopyStage stepKey={1} direction={direction}>
                <Text style={styles.stepTitle}>{m.onboarding.nodeTitle}</Text>
                <Text style={styles.stepSub}>{m.onboarding.nodeSub}</Text>

                <View style={[styles.inputPill, urlFocused && styles.inputPillFocused]}>
                  <TextInput
                    accessibilityLabel={m.onboarding.urlInputLabel}
                    value={url}
                    onChangeText={setUrl}
                    onFocus={() => setUrlFocused(true)}
                    onBlur={() => setUrlFocused(false)}
                    onSubmitEditing={advanceToToken}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    returnKeyType="next"
                    placeholder={m.onboarding.urlPlaceholder}
                    placeholderTextColor={colors.caption}
                    selectionColor={colors.ink}
                    style={styles.textInput}
                  />
                  {url.length > 0 && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={m.onboarding.clearUrlLabel}
                      hitSlop={8}
                      onPress={() => setUrl("")}
                      style={styles.inlineIconBtn}
                    >
                      <X size={14} strokeWidth={2.2} color={colors.muted} />
                    </Pressable>
                  )}
                </View>

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
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text
                          style={[styles.schemeChipText, active && styles.schemeChipTextActive]}
                        >
                          {scheme}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {needsAutoScheme && urlValid ? (
                  <Text style={styles.hintText}>{m.onboarding.autoSchemeHint(normalizedUrl)}</Text>
                ) : url.trim().length > 0 && !urlValid ? (
                  <Text style={styles.warnText}>{m.onboarding.invalidUrlWarn}</Text>
                ) : null}
              </CopyStage>
            </View>
          )}

          {step === 2 && (
            <View style={styles.formLayout}>
              <ArtworkStage
                stepKey={2}
                direction={direction}
                size={188}
                source={keySource}
                label={m.onboarding.keyArtLabel}
              />
              <CopyStage stepKey={2} direction={direction}>
                <Text style={styles.stepTitle}>{m.onboarding.keyTitle}</Text>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={m.onboarding.editHostLabel}
                  onPress={() => goTo(1)}
                  style={({ pressed }) => [styles.hostPill, pressed && styles.pressed]}
                >
                  <Globe size={12} strokeWidth={2} color={colors.muted} />
                  <Text numberOfLines={1} style={styles.hostPillText}>
                    {normalizedUrl}
                  </Text>
                  <Text style={styles.hostPillAction}>{m.onboarding.editHost}</Text>
                </Pressable>

                <View style={[styles.inputPill, tokenFocused && styles.inputPillFocused]}>
                  <TextInput
                    accessibilityLabel={m.onboarding.tokenInputLabel}
                    value={token}
                    onChangeText={setToken}
                    onFocus={() => setTokenFocused(true)}
                    onBlur={() => setTokenFocused(false)}
                    onSubmitEditing={handleSubmit}
                    autoCapitalize="none"
                    autoCorrect={false}
                    secureTextEntry={!visible}
                    returnKeyType="done"
                    placeholder={m.onboarding.tokenPlaceholder}
                    placeholderTextColor={colors.caption}
                    selectionColor={colors.ink}
                    style={styles.textInput}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      visible ? m.onboarding.hideTokenLabel : m.onboarding.showTokenLabel
                    }
                    hitSlop={8}
                    onPress={() => setVisible((prev) => !prev)}
                    style={styles.inlineIconBtn}
                  >
                    {visible ? (
                      <EyeOff size={16} strokeWidth={1.9} color={colors.muted} />
                    ) : (
                      <Eye size={16} strokeWidth={1.9} color={colors.muted} />
                    )}
                  </Pressable>
                </View>

                {error ? (
                  <FadeSlideIn offset={4} duration={160} style={styles.errorPill}>
                    <Text accessibilityRole="alert" style={styles.errorText}>
                      {error}
                    </Text>
                  </FadeSlideIn>
                ) : (
                  <Text style={styles.hintText}>{m.onboarding.tokenHint}</Text>
                )}
              </CopyStage>
            </View>
          )}
        </ScrollView>

        <View style={styles.bottomBar}>
          {step === 0 && (
            <SpringPressable
              scaleTo={0.97}
              accessibilityRole="button"
              accessibilityLabel={m.onboarding.startLabel}
              onPress={() => goTo(1)}
              style={styles.primaryBtn}
            >
              <Text style={styles.primaryBtnText}>{m.onboarding.startAction}</Text>
              <ArrowRight size={16} strokeWidth={2.2} color={colors.surface} />
            </SpringPressable>
          )}

          {step === 1 && (
            <SpringPressable
              scaleTo={0.97}
              accessibilityRole="button"
              accessibilityLabel={m.onboarding.nextLabel}
              disabled={!urlValid}
              onPress={advanceToToken}
              style={[styles.primaryBtn, !urlValid && styles.primaryBtnDisabled]}
            >
              <Text style={[styles.primaryBtnText, !urlValid && styles.primaryBtnTextDisabled]}>
                {m.onboarding.nextAction}
              </Text>
              <ArrowRight
                size={16}
                strokeWidth={2.2}
                color={urlValid ? colors.surface : colors.caption}
              />
            </SpringPressable>
          )}

          {step === 2 && (
            <SpringPressable
              scaleTo={0.97}
              accessibilityRole="button"
              accessibilityLabel={m.onboarding.verifyLabel}
              disabled={!canSubmit}
              onPress={handleSubmit}
              style={[styles.primaryBtn, !canSubmit && styles.primaryBtnDisabled]}
            >
              <Text style={[styles.primaryBtnText, !canSubmit && styles.primaryBtnTextDisabled]}>
                {busy ? m.onboarding.connectingAction : m.onboarding.verifyAction}
              </Text>
              {!busy && (
                <ArrowRight
                  size={16}
                  strokeWidth={2.2}
                  color={canSubmit ? colors.surface : colors.caption}
                />
              )}
            </SpringPressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  langRow: {
    marginTop: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  langChip: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  langChipActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  langChipPressed: {
    opacity: 0.72,
  },
  langChipText: {
    fontSize: 12.5,
    fontWeight: "500",
    color: colors.secondary,
  },
  langChipTextActive: {
    color: colors.surface,
    fontWeight: "600",
  },
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 6,
  },
  topSide: {
    width: 60,
    alignItems: "flex-start",
  },
  topSideRight: {
    alignItems: "flex-end",
  },
  circleBtn: {
    width: 34,
    height: 34,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  skipBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  skipText: {
    fontSize: 13.5,
    fontWeight: "500",
    color: colors.muted,
  },
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radii.full,
    backgroundColor: colors.rail,
  },
  dotPassed: {
    backgroundColor: colors.inkSoft,
  },
  dotActive: {
    width: 22,
    backgroundColor: colors.ink,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingBottom: 16,
    maxWidth: 460,
    width: "100%",
    alignSelf: "center",
  },
  heroLayout: {
    alignItems: "center",
    paddingBottom: 20,
  },
  formLayout: {
    alignItems: "center",
    paddingBottom: 12,
  },
  artWrap: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  copyStage: {
    width: "100%",
    alignItems: "center",
  },
  heroTitle: {
    fontSize: 27,
    lineHeight: 34,
    fontWeight: "700",
    letterSpacing: -0.8,
    color: colors.ink,
    textAlign: "center",
  },
  heroSub: {
    marginTop: 8,
    fontSize: 15,
    lineHeight: 22,
    color: colors.muted,
    textAlign: "center",
  },
  stepTitle: {
    fontSize: 24,
    lineHeight: 30,
    fontWeight: "700",
    letterSpacing: -0.6,
    color: colors.ink,
    textAlign: "center",
  },
  stepSub: {
    marginTop: 6,
    marginBottom: 24,
    fontSize: 14,
    lineHeight: 20,
    color: colors.muted,
    textAlign: "center",
  },
  hostPill: {
    marginTop: 10,
    marginBottom: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
  },
  hostPillText: {
    flexShrink: 1,
    fontSize: 12.5,
    color: colors.secondary,
  },
  hostPillAction: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.ink,
  },
  inputPill: {
    width: "100%",
    height: 52,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: "transparent",
    backgroundColor: colors.soft,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  inputPillFocused: {
    backgroundColor: colors.surface,
    borderColor: colors.ink,
  },
  textInput: {
    flex: 1,
    fontSize: 15.5,
    color: colors.ink,
    padding: 0,
  },
  inlineIconBtn: {
    width: 28,
    height: 28,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
  schemeRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  schemeChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radii.full,
    backgroundColor: colors.soft,
  },
  schemeChipActive: {
    backgroundColor: colors.ink,
  },
  schemeChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.secondary,
  },
  schemeChipTextActive: {
    color: colors.surface,
  },
  hintText: {
    marginTop: 12,
    fontSize: 12,
    color: colors.caption,
    textAlign: "center",
  },
  warnText: {
    marginTop: 12,
    fontSize: 12,
    color: colors.danger,
    textAlign: "center",
  },
  errorPill: {
    marginTop: 12,
    width: "100%",
    borderRadius: 12,
    backgroundColor: colors.dangerSoft,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  errorText: {
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.danger,
    textAlign: "center",
  },
  bottomBar: {
    paddingHorizontal: 28,
    paddingTop: 8,
    paddingBottom: 20,
    maxWidth: 460,
    width: "100%",
    alignSelf: "center",
  },
  primaryBtn: {
    height: 52,
    borderRadius: radii.full,
    backgroundColor: colors.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryBtnDisabled: {
    backgroundColor: colors.soft,
  },
  primaryBtnText: {
    fontSize: 15.5,
    fontWeight: "600",
    color: colors.surface,
    letterSpacing: -0.2,
  },
  primaryBtnTextDisabled: {
    color: colors.caption,
  },
  pressed: {
    opacity: 0.72,
  },
});
