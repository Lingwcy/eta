import type { ImageAttachment } from "./bot/contracts.ts";
import { getMessages } from "./i18n/index.ts";

/** Inspect returned bytes: the native picker can convert HEIC to JPEG without updating its name. */
export function pickedImage(asset: {
  base64?: string | null;
  fileName?: string | null;
}): ImageAttachment {
  const { errors } = getMessages();
  const data = asset.base64;
  if (!data) throw new Error(errors.imageUnreadable);
  if (data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4) throw new Error(errors.imageTooLarge);
  const mimeType = data.startsWith("/9j/")
    ? "image/jpeg"
    : data.startsWith("iVBORw0KGgo")
      ? "image/png"
      : data.startsWith("R0lGOD")
        ? "image/gif"
        : data.startsWith("UklGR") && data.slice(11, 16) === "XRUJQ"
          ? "image/webp"
          : undefined;
  if (!mimeType) throw new Error(errors.imageUnsupportedFormat);
  return { type: "image", data, mimeType, ...(asset.fileName ? { name: asset.fileName } : {}) };
}
