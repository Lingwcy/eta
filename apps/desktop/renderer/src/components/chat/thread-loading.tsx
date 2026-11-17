import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function ThreadLoading({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  useTranslation();
  return (
    <div
      className={
        loading
          ? "flex flex-1 flex-col items-center justify-center gap-2.5 py-12 text-muted motion-safe:animate-[eta-delayed-fade-in_320ms_ease-out_both]"
          : "flex flex-1 flex-col items-center justify-center gap-2.5 py-12 text-muted transition-opacity duration-(--eta-duration-panel) starting:opacity-0 motion-reduce:duration-(--eta-duration-fast)"
      }
    >
      <MessageSquare size={22} strokeWidth={1.4} aria-hidden="true" />
      <p role="status" className="text-xs text-subtle">
        {loading
          ? t("chat:threadLoading.loadingChatHistory")
          : t("chat:threadLoading.chatHistoryIsNotLoaded")}
      </p>
      {loading ? (
        <div aria-hidden="true" className="mt-2 flex w-52 flex-col gap-2">
          <Skeleton size="xs" className="w-3/4" />
          <Skeleton size="xs" className="w-full" />
          <Skeleton size="xs" className="w-2/3" />
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("chat:threadLoading.reload")}
        </Button>
      )}
    </div>
  );
}
