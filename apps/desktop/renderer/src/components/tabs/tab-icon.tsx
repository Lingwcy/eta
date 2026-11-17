import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { Globe2, MessageCircle, Settings2 } from "lucide-react";
import type { TabPresentation } from "@/agent/tab-presentations";

export function TabIcon({ item }: { item: TabPresentation }) {
  useTranslation();
  if (item.running)
    return (
      <span
        className="relative inline-flex size-2 shrink-0 items-center justify-center"
        aria-label={t("navigation:tabIcon.running")}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-brand/60 motion-safe:animate-[eta-pulse-ring_1.8s_cubic-bezier(0,0,0.2,1)_infinite] motion-reduce:hidden"
        />
        <span aria-hidden="true" className="relative size-2 rounded-full bg-brand" />
      </span>
    );
  if (item.kind === "browser" && item.favicon)
    return (
      <img
        src={item.favicon}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        className="size-4 shrink-0 rounded-sm"
      />
    );
  const Icon =
    item.kind === "settings" ? Settings2 : item.kind === "browser" ? Globe2 : MessageCircle;
  return <Icon size={17} className="shrink-0" aria-hidden="true" />;
}
