import { KeyRound, UserRound, Shield, Wrench, HardDrive, MessageCircle } from "lucide-react";
export const settingsGroups = [
  {
    label: "模型连接",
    items: [
      { id: "accounts", label: "账户登录", title: "Sign in with an account", icon: UserRound },
      { id: "api-keys", label: "API Key 登录", title: "Sign in with an API key", icon: KeyRound },
    ],
  },
  {
    label: "应用",
    items: [
      { id: "conversations", label: "对话", title: "对话", icon: MessageCircle },
      { id: "permissions", label: "权限", title: "权限", icon: Shield },
      { id: "tools", label: "工具函数", title: "工具函数", icon: Wrench },
      { id: "storage", label: "存储", title: "存储", icon: HardDrive },
    ],
  },
];
