import { t } from "@/i18n";
import {
  Palette,
  KeyRound,
  UserRound,
  Shield,
  Wrench,
  HardDrive,
  MessageCircle,
  BookOpen,
  Info,
  Bot,
} from "lucide-react";
export const settingsGroups = () => [
  {
    id: "models",
    label: t("settings:settingsCategories.modelConnections"),
    items: [
      {
        id: "accounts" as const,
        label: t("settings:settingsCategories.accountSignIn"),
        title: t("settings:settingsCategories.accountTitle"),
        icon: UserRound,
      },
      {
        id: "api-keys" as const,
        label: t("settings:settingsCategories.apiKeySignIn"),
        title: t("settings:settingsCategories.apiKeyTitle"),
        icon: KeyRound,
      },
    ],
  },
  {
    id: "application",
    label: t("settings:settingsCategories.application"),
    items: [
      { id: "bot" as const, label: "Bot", title: "Bot", icon: Bot },
      {
        id: "appearance" as const,
        label: t("settings:settingsCategories.appearance"),
        title: t("settings:settingsCategories.appearance"),
        icon: Palette,
      },
      {
        id: "subagents" as const,
        label: t("settings:settingsCategories.subagents"),
        title: t("settings:settingsCategories.subagents"),
        icon: Bot,
      },
      {
        id: "conversations" as const,
        label: t("settings:settingsCategories.conversations"),
        title: t("settings:settingsCategories.conversations"),
        icon: MessageCircle,
      },
      {
        id: "permissions" as const,
        label: t("settings:settingsCategories.permissions"),
        title: t("settings:settingsCategories.permissions"),
        icon: Shield,
      },
      {
        id: "tools" as const,
        label: t("settings:settingsCategories.tools"),
        title: t("settings:settingsCategories.tools"),
        icon: Wrench,
      },
      {
        id: "skills" as const,
        label: t("settings:settingsCategories.skills"),
        title: t("settings:settingsCategories.skills"),
        icon: BookOpen,
      },
      {
        id: "storage" as const,
        label: t("settings:settingsCategories.storage"),
        title: t("settings:settingsCategories.storage"),
        icon: HardDrive,
      },
    ],
  },
  {
    id: "other",
    label: t("settings:settingsCategories.other"),
    items: [
      {
        id: "about" as const,
        label: t("settings:settingsCategories.about"),
        title: t("settings:settingsCategories.about"),
        icon: Info,
      },
    ],
  },
];

export type SettingsItem = ReturnType<typeof settingsGroups>[number]["items"][number];
export type SettingsCategory = SettingsItem["id"];
