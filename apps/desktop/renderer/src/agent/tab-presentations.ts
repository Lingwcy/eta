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
        title: "设置",
        subtitle: "Eta",
        text: "管理账户、API Key、工具和图片权限。",
      };
    case "browser": {
      const page = browser?.page;
      const hostname = tab.url ? new URL(tab.url).hostname : "网页";
      return {
        ...identity,
        title: page?.title || tab.title || hostname,
        subtitle: tab.url ? hostname : "新标签页",
        favicon: page?.favicon,
        preview: page?.preview,
        text: tab.url ? "选择标签，继续浏览此网页。" : "输入网址或搜索内容，开始浏览。",
      };
    }
    case "conversation": {
      const thread = library?.threads.find((thread) => thread.id === tab.threadId);
      const workspace = library?.workspaces.find((workspace) => workspace.id === tab.workspaceId);
      const project = library?.projects.find((project) => project.id === workspace?.projectId);
      return {
        ...identity,
        title: thread?.title || "新聊天",
        subtitle: tab.threadId
          ? `${isCloudId(tab.threadId) ? "云端 · " : ""}${project?.name ?? "聊天"}`
          : tab.environment === "cloud" || isCloudId(tab.workspaceId)
            ? "云端草稿"
            : "草稿",
        text: tab.draft || preview || thread?.title || "选择项目，开始新的聊天。",
        running: tab.threadId !== undefined && running.has(tab.threadId),
      };
    }
  }
}
