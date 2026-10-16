import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThreadLoading({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-neutral-400 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none">
      <MessageSquare size={28} strokeWidth={1.3} aria-hidden="true" />
      <p role="status" className="text-xs">
        {loading
          ? t("chat:threadLoading.loadingChatHistory")
          : t("chat:threadLoading.chatHistoryIsNotLoaded")}
      </p>
      {loading ? (
        <div aria-hidden="true" className="mt-3 flex w-56 flex-col gap-2.5">
          <div className="h-2 w-4/5 rounded-full bg-neutral-100" />
          <div className="h-2 rounded-full bg-neutral-100" />
          <div className="h-2 w-3/5 rounded-full bg-neutral-100" />
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("chat:threadLoading.reload")}
        </Button>
      )}
    </div>
  );
}
