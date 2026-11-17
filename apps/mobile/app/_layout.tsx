import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MobileProvider, useMobile } from "../src/provider.tsx";
import { colors } from "../src/ui.tsx";

void SplashScreen.preventAutoHideAsync().catch(() => {});
try {
  SplashScreen.setOptions({ duration: 220, fade: true });
} catch {
  // Web and non-native test runtimes may omit native splash options.
}

function AppShell() {
  const { state, booting } = useMobile();
  const [layoutReady, setLayoutReady] = useState(false);
  const [failsafeReady, setFailsafeReady] = useState(false);
  const hiddenRef = useRef(false);

  useEffect(() => {
    // Allow initial Bot connection + active thread restore up to 5s before dismissing splash on unreachable networks.
    const timer = setTimeout(() => setFailsafeReady(true), 5000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (hiddenRef.current || !layoutReady) return;
    if ((booting || state.status === "loading") && !failsafeReady) return;
    hiddenRef.current = true;
    void SplashScreen.hideAsync().catch(() => {});
  }, [booting, failsafeReady, layoutReady, state.status]);

  return (
    <View
      style={{ flex: 1, backgroundColor: colors.background }}
      onLayout={() => setLayoutReady(true)}
    >
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="settings" options={{ presentation: "modal" }} />
      </Stack>
    </View>
  );
}

export default function Layout() {
  return (
    <SafeAreaProvider>
      <MobileProvider>
        <AppShell />
      </MobileProvider>
    </SafeAreaProvider>
  );
}
