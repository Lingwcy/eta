import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import type { ReactNode } from "react";

export const PreviewCard = BasePreviewCard.Root;
export const PreviewCardTrigger = BasePreviewCard.Trigger;

/** Shared popup follows the active trigger without replaying its entrance animation. */
export function PreviewCardContent({ children }: { children: ReactNode }) {
  return (
    <BasePreviewCard.Portal>
      <BasePreviewCard.Positioner
        side="right"
        sideOffset={12}
        className="z-40 transition-transform duration-200 ease-out motion-reduce:transition-none"
      >
        <BasePreviewCard.Popup className="w-[320px] max-w-[calc(100vw-48px)] overflow-hidden rounded-xl border border-neutral-200 bg-white p-3 shadow-[0_8px_24px_#00000012] outline-none transition-[opacity,transform] duration-150 data-starting-style:translate-x-1 data-starting-style:opacity-0 data-ending-style:translate-x-1 data-ending-style:opacity-0 motion-reduce:transition-none">
          {children}
        </BasePreviewCard.Popup>
      </BasePreviewCard.Positioner>
    </BasePreviewCard.Portal>
  );
}
