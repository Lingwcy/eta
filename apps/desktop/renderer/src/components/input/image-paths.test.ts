import { expect, test } from "vite-plus/test";
import { extractImagePaths } from "./image-paths";

test("explicit image references support relative paths, home paths and quoted spaces", () => {
  expect(
    extractImagePaths("Describe @./shot.png @\"~/Pictures/my shot.webp\" @'/tmp/my image.jpg'"),
  ).toEqual({
    prompt: "Describe",
    paths: ["./shot.png", "~/Pictures/my shot.webp", "/tmp/my image.jpg"],
  });
  expect(extractImagePaths("mail me@sample.png and @source.ts")).toEqual({
    prompt: "mail me@sample.png and @source.ts",
    paths: [],
  });
  expect(extractImagePaths("@/tmp/image.gif")).toEqual({ prompt: "", paths: ["/tmp/image.gif"] });
});
