import { jpegOrientation } from "../../images/orientation.ts";
import type { ImageProcessor } from "../../images/types.ts";
import { DEFAULT_IMAGE_LIMITS } from "../../images/types.ts";

/** Photon embeds its WASM in the bundle, so the packaged app needs no external codec files. */
export const processImage: ImageProcessor = async (bytes, name, options) => {
  if (bytes.length > 32 * 1024 * 1024) throw new Error("图片文件超过 32 MiB");
  const { PhotonImage, resize, SamplingFilter } = await import("@cf-wasm/photon/node");
  let image = (() => {
    try {
      return PhotonImage.new_from_byteslice(bytes);
    } catch {
      throw new Error(`无法解码图片：${name}`);
    }
  })();
  try {
    const orientation = jpegOrientation(bytes);
    if (orientation !== 1) {
      const w = image.get_width(),
        h = image.get_height();
      const source = image.get_raw_pixels();
      const target = new Uint8Array(source.length);
      const width = orientation >= 5 ? h : w;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const [tx, ty] =
            orientation === 2
              ? [w - 1 - x, y]
              : orientation === 3
                ? [w - 1 - x, h - 1 - y]
                : orientation === 4
                  ? [x, h - 1 - y]
                  : orientation === 5
                    ? [y, x]
                    : orientation === 6
                      ? [h - 1 - y, x]
                      : orientation === 7
                        ? [h - 1 - y, w - 1 - x]
                        : [y, w - 1 - x];
          target.set(source.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ty * width + tx) * 4);
        }
      image.free();
      image = new PhotonImage(target, width, orientation >= 5 ? w : h);
    }
    const original = { width: image.get_width(), height: image.get_height() };
    const limits = { ...DEFAULT_IMAGE_LIMITS, ...options };
    const scale = Math.min(1, limits.maxWidth / original.width, limits.maxHeight / original.height);
    let width = Math.max(1, Math.floor(original.width * scale));
    let height = Math.max(1, Math.floor(original.height * scale));
    const shrink = () => {
      const next = resize(image, width, height, SamplingFilter.Lanczos3);
      image.free();
      image = next;
    };
    if (scale < 1) shrink();
    const maxBytes = Math.min(limits.maxBytes, DEFAULT_IMAGE_LIMITS.maxBytes);
    const sourceMime =
      bytes[0] === 0xff && bytes[1] === 0xd8
        ? "image/jpeg"
        : bytes[0] === 0x89 && bytes[1] === 0x50
          ? "image/png"
          : undefined;
    const retain =
      sourceMime && scale === 1 && orientation === 1 && Math.ceil(bytes.length / 3) * 4 < maxBytes;
    let data = Buffer.from(retain ? bytes : image.get_bytes()).toString("base64");
    let mimeType = retain ? sourceMime : "image/png";
    if (data.length >= maxBytes) {
      mimeType = "image/jpeg";
      data = Buffer.from(image.get_bytes_jpeg(options?.jpegQuality ?? 80)).toString("base64");
      for (let attempt = 0; data.length >= maxBytes && attempt < 30; attempt++) {
        width = Math.max(1, Math.floor(width * 0.8));
        height = Math.max(1, Math.floor(height * 0.8));
        shrink();
        data = Buffer.from(image.get_bytes_jpeg(70)).toString("base64");
      }
    }
    if (data.length >= maxBytes) throw new Error(`无法将图片缩小到模型限制：${name}`);
    const notes = [];
    if (mimeType !== sourceMime) notes.push(`[Image converted to ${mimeType}.]`);
    if (width !== original.width || height !== original.height)
      notes.push(
        `[Image: original ${original.width}x${original.height}, displayed at ${width}x${height}. Multiply coordinates by ${(original.width / width).toFixed(2)} to map to original image.]`,
      );
    return {
      type: "image",
      name,
      data,
      mimeType,
      ...(notes.length ? { note: notes.join("\n") } : {}),
    };
  } finally {
    image.free();
  }
};
