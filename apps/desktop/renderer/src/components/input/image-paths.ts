/** Explicit @ references only; ordinary paths and email addresses stay text. */
export function extractImagePaths(text: string) {
  const paths: string[] = [];
  const prompt = text
    .replace(
      /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g,
      (
        match,
        prefix: string,
        double: string | undefined,
        single: string | undefined,
        plain: string | undefined,
      ) => {
        const path = double ?? single ?? plain ?? "";
        if (!/\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i.test(path)) return match;
        paths.push(path);
        return prefix;
      },
    )
    .trim();
  return { prompt, paths };
}
