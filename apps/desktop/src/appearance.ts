/** Shared by persisted preferences and the renderer's thinking indicators. */
export const agentThinkingVariants = ["wave", "spin", "stars", "infinity"] as const;
export type AgentThinkingVariant = (typeof agentThinkingVariants)[number];

/** Persist the preference, never the system's currently resolved appearance. */
export const themePreferences = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof themePreferences)[number];
export type ResolvedTheme = Exclude<ThemePreference, "system">;
export type AppearanceSnapshot = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  revision: number;
};

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export const windowThemeColors = {
  light: { background: "#e9e9e9", foreground: "#262626" },
  dark: { background: "#191a1c", foreground: "#eceef1" },
} as const;
