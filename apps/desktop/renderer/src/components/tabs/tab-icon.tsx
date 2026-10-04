import { Globe2, MessageCircle, Settings2 } from "lucide-react";
import type { TabPresentation } from "@/agent/tab-presentations";

export function TabIcon({ item }: { item: TabPresentation }) {
  if (item.running)
    return <span className="size-2 shrink-0 rounded-full bg-[#ed714b]" aria-label="正在执行" />;
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
