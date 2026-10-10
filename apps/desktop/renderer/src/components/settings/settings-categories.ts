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
export const settingsGroups = [
  {
    label: "模型连接",
    items: [
      {
        id: "accounts" as const,
        label: "账户登录",
        title: "Sign in with an account",
        icon: UserRound,
      },
      {
        id: "api-keys" as const,
        label: "API Key 登录",
        title: "Sign in with an API key",
        icon: KeyRound,
      },
    ],
  },
  {
    label: "应用",
    items: [
      { id: "bot" as const, label: "Bot", title: "Bot", icon: Bot },
      { id: "appearance" as const, label: "外观", title: "外观", icon: Palette },
      { id: "subagents" as const, label: "子智能体", title: "子智能体", icon: Bot },
      { id: "conversations" as const, label: "对话", title: "对话", icon: MessageCircle },
      { id: "permissions" as const, label: "权限", title: "权限", icon: Shield },
      { id: "tools" as const, label: "工具函数", title: "工具函数", icon: Wrench },
      { id: "skills" as const, label: "技能", title: "技能", icon: BookOpen },
      { id: "storage" as const, label: "存储", title: "存储", icon: HardDrive },
    ],
  },
  {
    label: "其他",
    items: [{ id: "about" as const, label: "关于", title: "关于", icon: Info }],
  },
];

export type SettingsItem = (typeof settingsGroups)[number]["items"][number];
export type SettingsCategory = SettingsItem["id"];
