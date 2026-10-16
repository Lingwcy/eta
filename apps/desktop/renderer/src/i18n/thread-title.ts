import type { ThreadMetadata } from "@eta/core/shared/threads";
import { t } from "./index";

/** Only the initial Core sentinel is presentation text; temporary input titles are content. */
export function threadTitle(thread?: Pick<ThreadMetadata, "title" | "titleSource">) {
  return !thread?.title || (thread.titleSource === "temporary" && thread.title === "新会话")
    ? t("navigation:tabPresentations.newChat")
    : thread.title;
}
