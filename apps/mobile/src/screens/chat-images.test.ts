// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { MobileStore as Store } from "../bot/store.ts";
import type { ImagePickerResult } from "expo-image-picker";

const mocks = vi.hoisted(() => ({
  store: undefined as Store | undefined,
  pick: vi.fn<() => Promise<ImagePickerResult>>(),
}));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: mocks.pick }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("../provider.tsx", async () => {
  const React = await import("react");
  return {
    useMobile: () => {
      const store = mocks.store!;
      return {
        store,
        state: React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot),
      };
    },
  };
});
// Keep unrelated sheets out of the fixture; exercise the real screen, composer and status UI.
vi.mock("../components/sidebar.tsx", () => ({ Sidebar: () => null }));
vi.mock("./settings.tsx", () => ({ SettingsScreen: () => null }));
vi.mock("../components/configuration.tsx", () => ({
  ConfigurationSheet: () => null,
  sandboxLabels: { "workspace-write": "工作区写入", "read-only": "只读" },
  thinkingLabels: { off: "关闭" },
}));
vi.mock("../components/approvals.tsx", () => ({ Approvals: () => null }));
vi.mock("../components/message.tsx", () => ({ MessageView: () => null }));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    [
      "ArrowDown",
      "Menu",
      "SquarePen",
      "ArrowUp",
      "ChevronDown",
      "Cpu",
      "ImagePlus",
      "Shield",
      "Square",
      "X",
      "AlertTriangle",
      "CloudOff",
      "MessageSquare",
      "RefreshCw",
      "SlidersHorizontal",
    ].map((name) => [name, () => null]),
  ),
);
vi.mock("react-native-safe-area-context", async () => {
  const React = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", {}, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
  return {
    Alert: { alert: vi.fn() },
    View,
    Text,
    Pressable,
    ScrollView: View,
    KeyboardAvoidingView: View,
    FlatList: ({
      ListEmptyComponent,
      ListFooterComponent,
    }: {
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) => React.createElement("div", {}, ListEmptyComponent, ListFooterComponent),
    TextInput: ({
      value,
      editable,
      accessibilityLabel,
    }: {
      value?: string;
      editable?: boolean;
      accessibilityLabel?: string;
    }) =>
      React.createElement("textarea", {
        value,
        readOnly: !editable,
        "aria-label": accessibilityLabel,
        onChange: () => {},
      }),
    Image: ({
      source,
      accessibilityLabel,
    }: {
      source: { uri: string };
      accessibilityLabel?: string;
    }) => React.createElement("img", { src: source.uri, alt: accessibilityLabel }),
    Modal: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
      visible ? React.createElement("div", {}, children) : null,
    Platform: {
      OS: "android",
      select: (values: Record<string, unknown>) => values.android ?? values.default,
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

import { ChatScreen } from "./chat.tsx";
import { BotClient } from "../bot/client.ts";
import { MobileStore, draftKey } from "../bot/store.ts";
import {
  events,
  json,
  library,
  memoryStorage,
  requestBody,
  requestUrl,
  thread,
} from "../bot/fixtures.test-support.ts";

const bytes =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const picked: ImagePickerResult = {
  canceled: false,
  assets: [
    { uri: "file:///selected.png", width: 1, height: 1, fileName: "selected.png", base64: bytes },
  ],
};
const expectedImage = { type: "image", data: bytes, mimeType: "image/png", name: "selected.png" };
let root: Root;
let store: MobileStore;
let messages: ReturnType<typeof requestBody>[];

function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error("Missing button " + label);
  return found;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function previews() {
  return [...document.querySelectorAll("img")];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.pick.mockReset();
  messages = [];
  let id = 0;
  store = new MobileStore(
    memoryStorage().storage,
    (connection) =>
      new BotClient(connection, async (url, init) => {
        const path = new URL(requestUrl(url)).pathname;
        if (path === "/v1/library") return json({ ...library, threads: [thread.thread] });
        if (path.endsWith("/events")) return events(init?.signal);
        if (path.endsWith("/messages")) {
          messages.push(requestBody(init));
          return json({ operationId: "operation", kind: "run", startedAt: 1 }, 202);
        }
        return json(thread);
      }),
    () => "id-" + ++id,
  );
  await store.connect({ url: "https://bot", token: "secret" });
  mocks.store = store;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ChatScreen)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  store.dispose();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test("selecting, previewing and removing images updates the real draft, and image-only send admits its bytes", async () => {
  expect(button("发送消息").disabled).toBe(true);
  mocks.pick.mockResolvedValue(picked);
  await click("添加图片");
  expect(previews().map((image) => image.src)).toEqual(["data:image/png;base64," + bytes]);
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]).toHaveLength(1);
  expect(button("发送消息").disabled).toBe(false);
  await click("移除图片 1");
  expect(previews()).toHaveLength(0);
  expect(button("发送消息").disabled).toBe(true);
  await click("添加图片");
  await click("发送消息");
  expect(messages).toHaveLength(1);
  expect(messages[0]).toEqual({
    prompt: "",
    requestId: expect.any(String),
    images: [expectedImage],
  });
  expect(previews()).toHaveLength(0);
  expect(store.getSnapshot().pending).toBeUndefined();
});

test("returning from a backgrounded system picker retains the selected image", async () => {
  await act(async () => store.open("thread"));
  const selection = deferred<ImagePickerResult>();
  mocks.pick.mockReturnValue(selection.promise);
  await click("添加图片");
  await act(async () => store.setForeground(false));
  await act(async () => store.setForeground(true));
  await act(async () => selection.resolve(picked));
  expect(previews().map((image) => image.src)).toEqual(["data:image/png;base64," + bytes]);
  expect(store.getSnapshot().draftImages["thread:thread"]).toHaveLength(1);
  expect(button("发送消息").disabled).toBe(false);
});

test("cancel and picker failure preserve the existing image draft and text", async () => {
  mocks.pick.mockResolvedValue(picked);
  await click("添加图片");
  await act(async () => store.setDraft("keep this text"));
  const original = store.getSnapshot().draftImages[draftKey(store.getSnapshot())];
  mocks.pick.mockResolvedValue({ canceled: true, assets: null });
  await click("添加图片");
  expect(previews()).toHaveLength(1);
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]).toEqual(original);
  mocks.pick.mockRejectedValue(new Error("无法访问相册"));
  await click("添加图片");
  expect(document.body.textContent).toContain("无法访问相册");
  expect(previews()).toHaveLength(1);
  expect(store.getSnapshot().drafts[draftKey(store.getSnapshot())]).toBe("keep this text");
  expect(store.getSnapshot().draftImages[draftKey(store.getSnapshot())]).toEqual(original);
});

test("late selection and errors cannot modify a replacement conversation", async () => {
  const selection = deferred<ImagePickerResult>();
  mocks.pick.mockReturnValue(selection.promise);
  await click("添加图片");
  expect(button("正在读取图片").disabled).toBe(true);
  await act(async () => store.open("thread"));
  await act(async () => selection.resolve(picked));
  expect(previews()).toHaveLength(0);
  expect(store.getSnapshot().draftImages).toEqual({});
  const failure = deferred<ImagePickerResult>();
  mocks.pick.mockReturnValue(failure.promise);
  await click("添加图片");
  await act(async () => store.newThread());
  await act(async () => failure.reject(new Error("obsolete picker failure")));
  expect(document.body.textContent).not.toContain("obsolete picker failure");
  expect(store.getSnapshot().draftImages).toEqual({});
});
