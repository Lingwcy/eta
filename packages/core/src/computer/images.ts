import { createHash } from "node:crypto";
import type { ImageContent, Message } from "@earendil-works/pi-ai";

const digests = new WeakMap<ImageContent, string>();
export function computerImageDigest(image: ImageContent) {
  let digest = digests.get(image);
  if (!digest) {
    digest = createHash("sha256")
      .update(image.mimeType)
      .update(":")
      .update(image.data)
      .digest("hex");
    digests.set(image, digest);
  }
  return digest;
}

export function computerImageDigests(details: unknown): string[] {
  if (
    !details ||
    typeof details !== "object" ||
    !("computerImages" in details) ||
    !Array.isArray(details.computerImages)
  )
    return [];
  return details.computerImages.filter(
    (value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
  );
}

/** Bound only identified desktop observations in model input; durable history and other images stay intact. */
export function boundComputerImages(messages: readonly Message[], maximum = 4): readonly Message[] {
  let remaining = Math.max(0, maximum);
  const result = [...messages];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "toolResult") continue;
    const identified = new Set(computerImageDigests(message.details));
    if (!identified.size) continue;
    const keep = message.content.map(() => true);
    for (let part = message.content.length - 1; part >= 0; part--) {
      const content = message.content[part]!;
      if (content.type !== "image" || !identified.has(computerImageDigest(content))) continue;
      if (remaining > 0) remaining--;
      else keep[part] = false;
    }
    if (keep.some((value) => !value))
      result[index] = { ...message, content: message.content.filter((_value, part) => keep[part]) };
  }
  return result;
}
