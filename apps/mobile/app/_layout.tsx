import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { MobileProvider } from "../src/provider.tsx";
import { colors } from "../src/ui.tsx";

export default function Layout() {
  return (
    <SafeAreaProvider>
      <MobileProvider>
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
      </MobileProvider>
    </SafeAreaProvider>
  );
}
