import type { ConversationTab } from "@/agent/desktop-tabs";
import { isCloudId } from "../../../../src/shared/bot.ts";
import type { DesktopLibraryController } from "@/agent/use-desktop-library";
import { Avatar } from "@/components/ui/avatar";
import { SubscriptionQuota } from "@/components/subscription-quota";

/** Cloud models must never borrow a same-named local account's allowance. */
export function NavigationQuota({
  model,
  conversation,
  library,
}: {
  conversation?: ConversationTab;
  model?: DesktopLibraryController["mainModel"];
  library?: DesktopLibraryController["library"];
}) {
  const fallback = <Avatar label="Eta" fallback="η" src="./favicon.svg" />;
  const cloud =
    conversation &&
    (conversation.threadId || conversation.workspaceId
      ? isCloudId(conversation.threadId ?? conversation.workspaceId)
      : conversation.environment === "cloud");
  if (
    !conversation ||
    !model ||
    cloud ||
    model.cloud ||
    model.tabId !== conversation.id ||
    model.threadId !== conversation.threadId
  )
    return fallback;
  const connection = library?.credentials.some(
    (entry) => entry.providerId === model.provider && entry.type === "oauth",
  )
    ? library.quotaConnections?.find((entry) => entry.providerId === model.provider)
    : undefined;
  if (!connection) return fallback;
  return (
    <SubscriptionQuota
      key={JSON.stringify([
        model.tabId,
        model.threadId,
        model.provider,
        model.modelId,
        connection.connectionId,
      ])}
      providerId={connection.providerId}
      connectionId={connection.connectionId}
      fallback={fallback}
      autoRefresh
    />
  );
}
