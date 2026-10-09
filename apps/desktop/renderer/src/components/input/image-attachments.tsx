import { X, ImageIcon, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ImageAttachment, ImageSource } from "@eta/core/images/types";

export interface AttachmentItem {
  id: string;
  name: string;
  image?: ImageAttachment;
  source?: ImageSource;
  error?: string;
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
  return (
    <ul className="flex flex-wrap gap-2" aria-label="图片附件">
      {items.map((item) => (
        <li
          key={item.id}
          className="relative size-16 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50"
          title={item.error ?? item.name}
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
              aria-label={item.error ?? "正在处理图片"}
            >
              {item.error ? (
                <ImageIcon size={20} className="text-red-500" />
              ) : (
                <LoaderCircle size={18} className="text-neutral-400" />
              )}
            </div>
          )}
          <div className="absolute top-1 right-1 rounded-full bg-white/90">
            <Button
              variant="ghost-muted"
              size="icon-tiny"
              disabled={disabled}
              onClick={() => onRemove(item.id)}
              aria-label={`移除 ${item.name}`}
            >
              <X size={13} />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
