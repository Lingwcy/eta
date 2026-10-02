import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] }, noExternal: ["@eta/agent"] },
  test: { environment: "node", include: ["src/**/*.test.ts", "renderer/src/**/*.test.ts"] },
  pack: {
    inputOptions: {
      resolve: {
        // Only Agent uses workspace source; published Chord has no source files.
        alias: {
          "@eta/agent$": fileURLToPath(
            new URL("../../packages/agent/src/index.ts", import.meta.url),
          ),
          "@eta/agent/env/node$": fileURLToPath(
            new URL("../../packages/agent/src/env/node.ts", import.meta.url),
          ),
          "@eta/agent/tools$": fileURLToPath(
            new URL("../../packages/agent/src/tools/index.ts", import.meta.url),
          ),
        },
      },
    },
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
        "@earendil-works/chord",
        "@earendil-works/chord/**",
      ],
      neverBundle: ["electron"],
    },
  },
});
