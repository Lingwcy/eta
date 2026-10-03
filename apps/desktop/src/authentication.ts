export type LoginMethod = "oauth" | "api_key";

export interface AuthProvider {
  id: string;
  name: string;
  accountLabel?: string;
  methods: LoginMethod[];
}

export type LoginPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
};

/** Only interaction metadata crosses IPC; credentials remain in main. */
export interface LoginState {
  id: string;
  provider: string;
  method: LoginMethod;
  status: "running" | "completed" | "cancelled" | "failed";
  message: string;
  prompt?: LoginPrompt;
  links: { url: string; label?: string }[];
  deviceCode?: string;
}
