import type { SettingsSchema } from "./settings-schema.ts";
import type { SandboxMode } from "@eta/core/shared/sandbox";

export type DesktopSettings = typeof SettingsSchema.Type;

// New local chats use this default; persisted sessions keep their own policy.
export const defaultDesktopSandboxMode: SandboxMode = "danger-full-access";
