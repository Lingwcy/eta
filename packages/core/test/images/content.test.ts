import { expect, test } from "vite-plus/test";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { createModels, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { imageInput, omitImages } from "@eta/core/images/content";
import { processImage } from "@eta/core/node/images";
import { PhotonImage } from "@cf-wasm/photon/node";

const data =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const image = { type: "image" as const, name: "sample.png", mimeType: "image/png", data };

test("image-only and text plus image inputs store independent blocks, not base64 text", () => {
  expect(imageInput("", [image])).toEqual([{ type: "image", data, mimeType: "image/png" }]);
  expect(imageInput("Describe", [{ ...image, note: "Dimensions" }])).toEqual([
    { type: "text", text: "Describe" },
    { type: "image", data, mimeType: "image/png" },
    { type: "text", text: "Dimensions" },
  ]);
  expect(() => imageInput(" ")).toThrow("不能为空");
  expect(() => imageInput("", [{ ...image, data: "invalid<base64>" }])).toThrow("无效");
});

test("provider conversion omits images for text models without mutating saved history", () => {
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "image-test", models: [{ id: "text" }] }).provider);
  const model = models.getModel("image-test", "text")!;
  const history: Message[] = [
    { role: "user", content: imageInput("Describe", [image]), timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [image],
      isError: false,
      timestamp: 2,
    },
  ];
  const saved = structuredClone(history);
  const downgraded = transformMessages(history, { ...model, input: ["text"] });
  expect(JSON.stringify(downgraded)).toContain("(image omitted: model does not support images)");
  expect(JSON.stringify(downgraded)).toContain(
    "(tool image omitted: model does not support images)",
  );
  expect(JSON.stringify(downgraded)).not.toContain(data);
  expect(history).toEqual(saved);
  expect(
    JSON.stringify(transformMessages(history, { ...model, input: ["text", "image"] })),
  ).toContain(data);
  expect(JSON.stringify(omitImages(history))).toContain("Image reading is disabled.");
  expect(JSON.stringify(omitImages(history))).not.toContain(data);
  expect(history).toEqual(saved);
});

test("real decoder converts GIF and WebP to PNG and rejects invalid files", async () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  expect(await processImage(gif, "test.gif")).toMatchObject({
    type: "image",
    mimeType: "image/png",
  });
  const original = PhotonImage.new_from_byteslice(Buffer.from(data, "base64"));
  try {
    expect(await processImage(original.get_bytes_webp(), "test.webp")).toMatchObject({
      mimeType: "image/png",
    });
  } finally {
    original.free();
  }
  await expect(processImage(new Uint8Array([1, 2]), "bad.png")).rejects.toThrow("无法解码");
});

test("real resizing obeys model bounds and base64 budget with coordinate hints", async () => {
  const original = new PhotonImage(new Uint8Array(3000 * 4 * 4).fill(255), 3000, 4);
  try {
    const resized = await processImage(original.get_bytes(), "wide.png", { maxWidth: 1000 });
    const decoded = PhotonImage.new_from_byteslice(Buffer.from(resized.data, "base64"));
    try {
      expect(decoded.get_width()).toBe(1000);
      expect(resized.note).toContain("original 3000x4, displayed at 1000x1");
      expect(resized.note).toContain("3.00");
      expect(resized.data.length).toBeLessThan(4.5 * 1024 * 1024);
    } finally {
      decoded.free();
    }
  } finally {
    original.free();
  }
});

test("base64 budget can require JPEG encoding and a second dimension reduction", async () => {
  const pixels = new Uint8Array(128 * 128 * 4);
  let seed = 7;
  for (let index = 0; index < pixels.length; index++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels[index] = index % 4 === 3 ? 255 : seed >>> 24;
  }
  const original = new PhotonImage(pixels, 128, 128);
  try {
    const result = await processImage(original.get_bytes(), "noise.png", { maxBytes: 2000 });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThan(2000);
    const decoded = PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
    try {
      expect(decoded.get_width()).toBeLessThan(128);
    } finally {
      decoded.free();
    }
  } finally {
    original.free();
  }
});

test("camera EXIF orientation is applied before sizing and normalization", async () => {
  const original = new PhotonImage(new Uint8Array(3 * 2 * 4).fill(255), 3, 2);
  try {
    const jpeg = original.get_bytes_jpeg(80);
    // APP1 Exif, little-endian TIFF, one SHORT orientation entry with value 6.
    const exif = Buffer.from(
      "ffe1002245786966000049492a0008000000010012010300010000000600000000000000",
      "hex",
    );
    const bytes = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
    const result = await processImage(bytes, "camera.jpg");
    const decoded = PhotonImage.new_from_byteslice(Buffer.from(result.data, "base64"));
    try {
      expect([decoded.get_width(), decoded.get_height()]).toEqual([2, 3]);
    } finally {
      decoded.free();
    }
  } finally {
    original.free();
  }
});
