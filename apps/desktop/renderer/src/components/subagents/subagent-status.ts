import { t } from "@/i18n";
export const subagentStatus = () => ({
  running: t("inspector:subagentStatus.running"),
  queued: t("inspector:subagentStatus.queued"),
  paused: t("inspector:subagentStatus.paused"),
  completed: t("inspector:subagentStatus.completed"),
  failed: t("inspector:subagentStatus.error"),
  stopped: t("inspector:subagentStatus.stopped"),
});
