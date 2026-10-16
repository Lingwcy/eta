import { threadTitle } from "@/i18n/thread-title";
import { t } from "@/i18n";
import { isCloudId } from "../../../src/shared/bot.ts";
import type { DesktopLibrary } from "../../../src/bridge.ts";
import type { BrowserViewState } from "@/browser/client";
import type { DesktopTab } from "./desktop-tabs";

export interface TabPresentation {
  id: string;
  kind: DesktopTab["kind"];
  title: string;
  subtitle: string;
  text: string;
  favicon?: string;
  preview?: string;
  running?: boolean;
}

export function presentTab(
  tab: DesktopTab,
  library: DesktopLibrary | null,
  browser: BrowserViewState | undefined,
  preview: string | undefined,
  running: ReadonlySet<string>,
): TabPresentation {
  const identity = { id: tab.id, kind: tab.kind };
  switch (tab.kind) {
    case "settings":
      return {
        ...identity,
        title: t("navigation:tabPresentations.settings"),
        subtitle: "Eta",
        text: t("navigation:tabPresentations.manageAccountsApiKeysToolsAndImage"),
      };
    case "browser": {
      const page = browser?.page;
      const hostname = tab.url
        ? new URL(tab.url).hostname
        : t("navigation:tabPresentations.webPage");
      return {
        ...identity,
        title: !tab.url
          ? t("navigation:tabPresentations.newTab")
          : page?.title || tab.title || hostname,
        subtitle: tab.url ? hostname : t("navigation:tabPresentations.newTab"),
        favicon: page?.favicon,
        preview: page?.preview,
        text: tab.url
          ? t("navigation:tabPresentations.selectATabToContinueBrowsing")
          : t("navigation:tabPresentations.enterAUrlOrSearchToStart"),
      };
    }
    case "conversation": {
      const thread = library?.threads.find((thread) => thread.id === tab.threadId);
      const workspace = library?.workspaces.find((workspace) => workspace.id === tab.workspaceId);
      const project = library?.projects.find((project) => project.id === workspace?.projectId);
      return {
        ...identity,
        title: threadTitle(thread),
        subtitle: tab.threadId
          ? `${isCloudId(tab.threadId) ? t("navigation:tabPresentations.cloud") : ""}${project?.name ?? t("navigation:tabPresentations.chat")}`
          : tab.environment === "cloud" || isCloudId(tab.workspaceId)
            ? t("navigation:tabPresentations.cloudDraft")
            : t("navigation:tabPresentations.draft"),
        text:
          tab.draft ||
          preview ||
          (thread ? threadTitle(thread) : undefined) ||
          t("navigation:tabPresentations.chooseAProjectToStartANew"),
        running: tab.threadId !== undefined && running.has(tab.threadId),
      };
    }
  }
}
