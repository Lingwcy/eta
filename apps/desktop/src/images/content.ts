import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { ImageAttachment } from "./types.ts";
import { DEFAULT_IMAGE_LIMITS } from "./types.ts";

export function imageInput(
  prompt: string,
  images: readonly ImageAttachment[] = [],
  maxBytes = DEFAULT_IMAGE_LIMITS.maxBytes,
): UserMessage["content"] {
  if (!prompt.trim() && !images.length) throw new Error("消息不能为空");
  for (const image of images) {
    if (
      !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) ||
      !image.data ||
      image.data.length >= maxBytes ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
    )
      throw new Error("图片数据无效或过大");
  }
  if (!images.length) return prompt;
  return [
    ...(prompt.trim() ? [{ type: "text" as const, text: prompt.trim() }] : []),
    ...images.flatMap(({ data, mimeType, note }) => [
      { type: "image" as const, data, mimeType },
      ...(note ? [{ type: "text" as const, text: note }] : []),
    ]),
  ];
}

/** Request-only substitution leaves stored images available after settings/model changes. */
export function omitImages(messages: readonly Message[]): readonly Message[] {
  return messages.map((message) => {
    if (message.role === "assistant" || typeof message.content === "string") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "image"
          ? { type: "text" as const, text: "Image reading is disabled." }
          : part,
      ),
    };
  });
}
