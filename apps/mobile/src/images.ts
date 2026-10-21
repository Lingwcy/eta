import type { ImageAttachment } from "./bot/contracts.ts";

/** Inspect returned bytes: the native picker can convert HEIC to JPEG without updating its name. */
export function pickedImage(asset: {
  base64?: string | null;
  fileName?: string | null;
}): ImageAttachment {
  const data = asset.base64;
  if (!data) throw new Error("无法读取图片，请重新选择");
  if (data.length > Math.ceil((8 * 1024 * 1024) / 3) * 4)
    throw new Error("单张图片不能超过 8 MB，请压缩后重试");
  const mimeType = data.startsWith("/9j/")
    ? "image/jpeg"
    : data.startsWith("iVBORw0KGgo")
      ? "image/png"
      : data.startsWith("R0lGOD")
        ? "image/gif"
        : data.startsWith("UklGR") && data.slice(11, 16) === "XRUJQ"
          ? "image/webp"
          : undefined;
  if (!mimeType) throw new Error("请选择 JPEG、PNG、GIF 或 WebP 图片");
  return { type: "image", data, mimeType, ...(asset.fileName ? { name: asset.fileName } : {}) };
}
