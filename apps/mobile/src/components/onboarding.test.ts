// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { setLocale } from "../i18n/index.ts";

const mocks = vi.hoisted(() => ({
  useMobile: vi.fn(),
  useUpdater: vi.fn(),
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ back: mocks.back, canGoBack: mocks.canGoBack }),
}));

vi.mock("../provider.tsx", () => ({
  useMobile: mocks.useMobile,
  useUpdater: mocks.useUpdater,
}));

vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "ArrowLeft",
      "ArrowRight",
      "Code2",
      "Compass",
      "Download",
      "Eye",
      "EyeOff",
      "Globe",
      "KeyRound",
      "Layers",
      "Lock",
      "Power",
      "RefreshCw",
      "Server",
      "ShieldCheck",
      "Smartphone",
      "Sparkles",
      "Trash2",
      "X",
    ].map((name) => [name, () => null]),
  ),
);

vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", {}, children),
  };
});

vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", {}, children);
  const Text = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", {}, children);
  const Pressable = ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onPress,
        disabled,
        "aria-label": accessibilityLabel,
      },
      children,
    );
  const TextInput = ({
    value,
    onChangeText,
    placeholder,
    secureTextEntry,
    accessibilityLabel,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    placeholder?: string;
    secureTextEntry?: boolean;
    accessibilityLabel?: string;
  }) =>
    React.createElement("input", {
      value: value ?? "",
      placeholder,
      type: secureTextEntry ? "password" : "text",
      "aria-label": accessibilityLabel,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
    });
  const Image = ({
    source,
    accessibilityLabel,
  }: {
    source: string | { uri?: string };
    accessibilityLabel?: string;
  }) =>
    React.createElement("img", {
      src: typeof source === "string" ? source : (source?.uri ?? ""),
      alt: accessibilityLabel,
    });
  return {
    Alert: { alert: vi.fn() },
    Animated: {
      Value: class {
        setValue() {}
      },
      View,
      spring: () => ({ start: () => {}, stop: () => {} }),
      timing: () => ({ start: () => {}, stop: () => {} }),
      parallel: () => ({ start: () => {}, stop: () => {} }),
    },
    Easing: { out: () => () => 0, cubic: () => 0 },
    KeyboardAvoidingView: View,
    Platform: { OS: "android" },
    Pressable,
    ScrollView: View,
    StyleSheet: {
      create: <T>(styles: T) => styles,
      hairlineWidth: 1,
    },
    Text,
    TextInput,
    View,
    Image,
  };
});

import { isValidBotUrl, OnboardingWizard, prepareBotUrl, withScheme } from "./onboarding.tsx";
import { SettingsScreen } from "../screens/settings.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.back.mockReset();
  mocks.canGoBack.mockReturnValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLocale("en", false);
});

function setInput(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(label: string) {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  act(() => button!.click());
  return button!;
}

test("URL helpers normalize missing schemes and reject query/hash origins", () => {
  expect(prepareBotUrl("  bot.example.com/  ")).toBe("https://bot.example.com");
  expect(prepareBotUrl("http://192.168.1.10:3000/")).toBe("http://192.168.1.10:3000");
  expect(withScheme("http://bot.example.com", "https://")).toBe("https://bot.example.com");
  expect(isValidBotUrl("bot.example.com")).toBe(true);
  expect(isValidBotUrl("https://bot.example.com?token=1")).toBe(false);
  expect(isValidBotUrl("")).toBe(false);
});

test("OnboardingWizard steps through welcome, language switching, normalized Bot URL, and token pairing", async () => {
  const onConnect = vi.fn(async () => {});
  act(() => {
    root.render(createElement(OnboardingWizard, { onConnect }));
  });

  expect(container.textContent).toContain("Code anywhere");
  clickButton("简体中文");
  expect(container.textContent).toContain("随身编码，随时接管");
  clickButton("日本語");
  expect(container.textContent).toContain("どこでも、即座に開発");
  clickButton("English");
  expect(container.textContent).toContain("Code anywhere");

  clickButton("Start configuring Bot");

  expect(container.textContent).toContain("Connect node");
  const nextDisabled = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Next step"]',
  )!;
  expect(nextDisabled.disabled).toBe(true);

  setInput("Bot server URL", "bot.eta.dev/");
  expect(container.textContent).toContain("Will connect as https://bot.eta.dev");
  clickButton("Next step");

  expect(container.textContent).toContain("Pair device");
  expect(container.textContent).toContain("https://bot.eta.dev");

  const tokenInput = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Bot access token"]')!;
  expect(tokenInput().type).toBe("password");
  clickButton("Show token");
  expect(tokenInput().type).toBe("text");

  setInput("Bot access token", "  eta-admin-secret  ");
  await act(async () => {
    clickButton("Verify and connect");
  });

  expect(onConnect).toHaveBeenCalledWith({
    url: "https://bot.eta.dev",
    token: "eta-admin-secret",
  });
});

test("SettingsScreen enters wizard when onboarding and switches into guide mode and language from connected card", async () => {
  const connect = vi.fn(async () => {});
  const reconnect = vi.fn(async () => {});
  const disconnect = vi.fn(async () => {});

  const check = vi.fn(async () => ({ status: "idle" as const }));
  const setAutoCheck = vi.fn();

  mocks.useUpdater.mockReturnValue({
    updater: {
      check,
      downloadAndInstall: vi.fn(async () => {}),
      cancelDownload: vi.fn(),
      install: vi.fn(async () => {}),
      requestInstallPermission: vi.fn(async () => {}),
      openReleasePage: vi.fn(async () => {}),
      dismissBanner: vi.fn(),
      setAutoCheck,
    },
    update: {
      currentVersion: "0.1.0",
      platform: "android",
      supportsInAppInstall: true,
      autoCheck: true,
      state: { status: "idle" },
    },
  });

  mocks.useMobile.mockReturnValue({
    store: { connect, reconnect, disconnect },
    state: {
      status: "connected",
      url: "https://bot.example.com",
      sending: false,
      library: {
        workspaces: [{ id: "ws1", name: "eta" }],
        models: [{ provider: "openai", id: "gpt-6", name: "GPT-6" }],
        threads: [],
      },
    },
    booting: false,
  });

  act(() => {
    root.render(createElement(SettingsScreen));
  });

  expect(container.textContent).toContain("1 project · 1 model synced");
  clickButton("简体中文");
  expect(container.textContent).toContain("已同步 1 个项目 · 1 个可用模型");
  clickButton("English");
  expect(container.textContent).toContain("1 project · 1 model synced");

  await act(async () => {
    clickButton("Reconnect");
  });
  expect(reconnect).toHaveBeenCalledTimes(1);

  expect(container.textContent).toContain("Eta Mobile · v0.1.0");
  await act(async () => {
    clickButton("Check for updates");
  });
  expect(check).toHaveBeenCalledWith(true);
  clickButton("Check for updates automatically");
  expect(setAutoCheck).toHaveBeenCalledWith(false);

  clickButton("Open pairing guide");
  expect(container.textContent).toContain("Connect node");
  clickButton("Back");
  clickButton("Back to connection settings");
  expect(container.textContent).toContain("Switch node or update token");
});
