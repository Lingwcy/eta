import type { ImageContent, ModelImageResizeOptions } from "@earendil-works/pi-ai";

/** Prepared once before admission; the image itself remains an independent content block. */
export interface ImageAttachment extends ImageContent {
  name?: string;
  note?: string;
}
export type ImageSource = { path: string } | { data: string; name: string };
export type ImageProcessor = (
  bytes: Uint8Array,
  name: string,
  options?: ModelImageResizeOptions,
) => Promise<ImageAttachment>;
export const DEFAULT_IMAGE_LIMITS = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
};
