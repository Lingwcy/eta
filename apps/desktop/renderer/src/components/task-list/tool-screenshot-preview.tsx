import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, X } from "lucide-react";
import type { SnapshotTool } from "@eta/core/agent/protocol";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";

export interface ToolScreenshotImage {
  readonly data: string;
  readonly mimeType: string;
}

/** Extract screenshots that should be surfaced inline at the top of a computer-use tool row. */
export function computerScreenshotImages(tool: SnapshotTool): ToolScreenshotImage[] {
  const images = (tool.result?.content ?? []).flatMap((part) =>
    part.type === "image" ? [{ data: part.data, mimeType: part.mimeType }] : [],
  );
  if (!images.length) return [];
  if (tool.toolName === "computer") return images;
  if (tool.toolName !== "codemode") return [];
  const details = tool.result?.details;
  if (
    details &&
    typeof details === "object" &&
    "computerImages" in details &&
    Array.isArray(details.computerImages) &&
    details.computerImages.length > 0
  ) {
    return images;
  }
  return [];
}

/** Renders recorded computer-use screenshots directly under the tool header with click-to-preview. */
export function ToolScreenshotPreview({
  tool,
  images,
}: {
  tool: SnapshotTool;
  images: readonly ToolScreenshotImage[];
}) {
  useTranslation();
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const preview = previewIndex === null ? undefined : images[previewIndex];
  const alt = t("chat:toolDetails.imageResult", { toolName: tool.toolName });
  const heading = tool.description ?? tool.toolName;

  return (
    <>
      <div className="mt-1.5 mb-1 flex flex-wrap gap-2 pl-[22px]" data-computer-screenshots>
        {images.map((image, index) => (
          <button
            key={index}
            type="button"
            onClick={() => setPreviewIndex(index)}
            aria-label={t("chat:toolScreenshot.preview")}
            className="group relative block max-w-full cursor-zoom-in overflow-hidden rounded-[10px] border border-border/80 bg-surface-subtle/60 p-0 text-left shadow-[0_1px_2px_rgba(0,0,0,0.05)] transition-[border-color,box-shadow] duration-150 hover:border-border-strong hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--task-focus) motion-reduce:transition-none"
          >
            <img
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={alt}
              className="block max-h-[260px] w-auto max-w-[min(100%,460px)] object-contain"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-2 right-2 flex size-6 items-center justify-center rounded-md border border-white/15 bg-black/55 text-white opacity-0 backdrop-blur-xs transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            >
              <Maximize2 size={12} />
            </span>
          </button>
        ))}
      </div>
      <Dialog
        open={preview !== undefined}
        onOpenChange={(next) => {
          if (!next) setPreviewIndex(null);
        }}
      >
        {preview && (
          <DialogContent variant="media">
            <div className="mb-2 flex items-center justify-between gap-3 px-1.5 pt-0.5">
              <DialogTitle className="min-w-0 truncate text-xs font-medium text-foreground">
                {heading}
              </DialogTitle>
              <DialogClose
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-tiny"
                    aria-label={t("chat:toolScreenshot.close")}
                  />
                }
              >
                <X size={14} aria-hidden="true" />
              </DialogClose>
            </div>
            <div className="overflow-hidden rounded-[8px] border border-border/70 bg-surface-subtle/50">
              <img
                src={`data:${preview.mimeType};base64,${preview.data}`}
                alt={alt}
                className="block max-h-[calc(90dvh-64px)] w-auto max-w-[calc(92vw-24px)] object-contain"
              />
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
