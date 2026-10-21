import { describe, expect, it } from "vite-plus/test";
import { pickedImage } from "./images.ts";

describe("pickedImage", () => {
  it("uses actual JPEG bytes after native HEIC conversion", () => {
    expect(pickedImage({ base64: "/9j/AA==", fileName: "IMG.HEIC" })).toEqual({
      type: "image",
      data: "/9j/AA==",
      mimeType: "image/jpeg",
      name: "IMG.HEIC",
    });
  });
  it.each([
    ["iVBORw0KGgoAAA==", "image/png"],
    ["R0lGODlhAAAA", "image/gif"],
    ["UklGRhAAAABXRUJQVlA4IA==", "image/webp"],
  ])("recognizes %s", (base64, mimeType) => {
    expect(pickedImage({ base64 }).mimeType).toBe(mimeType);
  });
  it("rejects missing, unsupported and oversized data before upload", () => {
    expect(() => pickedImage({})).toThrow("无法读取");
    expect(() => pickedImage({ base64: "AAAA" })).toThrow("JPEG");
    expect(() => pickedImage({ base64: "/9j/" + "A".repeat(12 * 1024 * 1024) })).toThrow("8 MB");
  });
});
