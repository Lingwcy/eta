import type { MessageKey } from "./i18n/messages.ts";
import type { ScheduleSnapshot } from "@eta/core/shared/schedules";

export interface ScheduleEnvironment {
  id: string;
  label: string;
  status: "connected" | "offline" | "unsupported";
  message?: string;
  messageKey?: MessageKey;
}
export interface DesktopScheduleSnapshot {
  snapshots: readonly { environment: ScheduleEnvironment; data: ScheduleSnapshot }[];
}
