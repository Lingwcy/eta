import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ThreadLoading({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  useTranslation();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-12 text-neutral-400 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none">
      <MessageSquare size={22} strokeWidth={1.4} aria-hidden="true" />
      <p role="status" className="text-xs">
        {loading
          ? t("chat:threadLoading.loadingChatHistory")
          : t("chat:threadLoading.chatHistoryIsNotLoaded")}
      </p>
      {loading ? (
        <div aria-hidden="true" className="mt-2 flex w-52 flex-col gap-2">
          <div className="h-1.5 w-3/4 rounded-full bg-neutral-200/70" />
          <div className="h-1.5 rounded-full bg-neutral-200/70" />
          <div className="h-1.5 w-2/3 rounded-full bg-neutral-200/70" />
        </div>
      ) : (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("chat:threadLoading.reload")}
        </Button>
      )}
    </div>
  );
}
