import { useTranslation } from "react-i18next";
import { t } from "@/i18n";
import { X, ImageIcon, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ImageAttachment, ImageSource } from "@eta/core/images/types";
import { renderMessage, type Message } from "@/i18n/messages";

export interface AttachmentItem {
  id: string;
  name: string;
  image?: ImageAttachment;
  source?: ImageSource;
  error?: Message;
}

export function ImageAttachments({
  items,
  disabled,
  onRemove,
}: {
  items: readonly AttachmentItem[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  useTranslation();
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t("chat:imageAttachments.imageAttachments")}>
      {items.map((item) => (
        <li
          key={item.id}
          className="relative size-16 overflow-hidden rounded-[12px] border border-border bg-surface-soft"
          title={renderMessage(item.error) ?? item.name}
        >
          {item.image ? (
            <img
              src={`data:${item.image.mimeType};base64,${item.image.data}`}
              alt={item.name}
              className="size-full object-cover"
            />
          ) : (
            <div
              className="flex size-full items-center justify-center"
              aria-label={renderMessage(item.error) ?? t("chat:imageAttachments.processingImage")}
            >
              {item.error ? (
                <ImageIcon size={20} className="text-danger-text-500" />
              ) : (
                <LoaderCircle size={18} className="text-muted" />
              )}
            </div>
          )}
          <div className="absolute top-1 right-1 rounded-full bg-surface/90">
            <Button
              variant="ghost-muted"
              size="icon-tiny"
              disabled={disabled}
              onClick={() => onRemove(item.id)}
              aria-label={t("chat:imageAttachments.remove", { name: item.name })}
            >
              <X size={13} />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
