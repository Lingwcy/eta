import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SettingsToolbar({ onClose }: { onClose: () => void }) {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-1 px-3 [-webkit-app-region:drag] min-[1600px]:h-[52px]",
        navigator.userAgent.includes("Mac") && "pl-[94px]",
      )}
    >
      <div className="[-webkit-app-region:no-drag]">
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="返回聊天"
          title="返回聊天"
          onClick={onClose}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </Button>
      </div>
      <div className="[-webkit-app-region:no-drag]">
        <Button variant="ghost-muted" size="icon-sm" aria-label="前进" disabled>
          <ArrowRight size={18} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
