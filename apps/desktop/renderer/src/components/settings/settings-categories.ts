import { KeyRound, UserRound } from "lucide-react";
export const settingsGroups = [
  {
    label: "模型连接",
    items: [
      { id: "accounts", label: "账户登录", title: "Sign in with an account", icon: UserRound },
      { id: "api-keys", label: "API Key 登录", title: "Sign in with an API key", icon: KeyRound },
    ],
  },
];
