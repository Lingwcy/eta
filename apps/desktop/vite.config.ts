import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "renderer/src/**/*.test.ts"] },
  pack: {
    entry: ["src/main.ts", "src/preload.ts"],
    format: "cjs",
    outDir: "dist/electron",
    dts: false,
    outExtensions: () => ({ js: ".cjs" }),
    deps: {
      // The Electron main entry is CJS, while Agent and pi-ai expose ESM-only exports.
      alwaysBundle: [
        "@earendil-works/pi-ai",
        "@earendil-works/pi-ai/**",
        "@eta/agent",
        "@eta/agent/**",
      ],
      neverBundle: ["electron"],
    },
  },
});
