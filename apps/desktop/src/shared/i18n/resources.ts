import enBrowser from "./locales/en/browser.ts";
import enChat from "./locales/en/chat.ts";
import enCommon from "./locales/en/common.ts";
import enErrors from "./locales/en/errors.ts";
import enDiff from "./locales/en/diff.ts";
import enInspector from "./locales/en/inspector.ts";
import enNative from "./locales/en/native.ts";
import enNavigation from "./locales/en/navigation.ts";
import enSchedules from "./locales/en/schedules.ts";
import enSettings from "./locales/en/settings.ts";
import zhBrowser from "./locales/zh-CN/browser.ts";
import zhChat from "./locales/zh-CN/chat.ts";
import zhCommon from "./locales/zh-CN/common.ts";
import zhErrors from "./locales/zh-CN/errors.ts";
import zhDiff from "./locales/zh-CN/diff.ts";
import zhInspector from "./locales/zh-CN/inspector.ts";
import zhNative from "./locales/zh-CN/native.ts";
import zhNavigation from "./locales/zh-CN/navigation.ts";
import zhSchedules from "./locales/zh-CN/schedules.ts";
import zhSettings from "./locales/zh-CN/settings.ts";

export const resources = {
  en: {
    browser: enBrowser,
    chat: enChat,
    common: enCommon,
    errors: enErrors,
    diff: enDiff,
    inspector: enInspector,
    native: enNative,
    navigation: enNavigation,
    schedules: enSchedules,
    settings: enSettings,
  },
  "zh-CN": {
    browser: zhBrowser,
    chat: zhChat,
    common: zhCommon,
    errors: zhErrors,
    diff: zhDiff,
    inspector: zhInspector,
    native: zhNative,
    navigation: zhNavigation,
    schedules: zhSchedules,
    settings: zhSettings,
  },
} as const;
