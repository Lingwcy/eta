import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL,
  output: "static",
  trailingSlash: "always",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "zh"],
    routing: { prefixDefaultLocale: false },
  },
});
