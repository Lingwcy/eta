import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] }, noExternal: ["@eta/agent", "@eta/core"] },
  test: { environment: "node", include: ["src/**/*.test.ts", "renderer/src/**/*.test.ts"] },
  pack: {
    inputOptions: {
      resolve: {
        // Core and Agent use workspace source; published Chord has no source files.
        alias: {
          ...Object.fromEntries(
            globSync("packages/core/src/**/*.ts", {
              cwd: fileURLToPath(new URL("../../", import.meta.url)),
            })
              .map((path) => path.replaceAll("\\", "/"))
              .filter((path) => !path.endsWith(".test.ts"))
              .map((path) => [
                `@eta/core/${path.replace("packages/core/src/", "").replace(/\.ts$/, "")}$`,
                fileURLToPath(new URL(`../../${path}`, import.meta.url)),
              ]),
          ),
          "@eta/core$": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
          "@eta/agent$": fileURLToPath(
            new URL("../../packages/agent/src/index.ts", import.meta.url),
          ),
          "@eta/agent/env/node$": fileURLToPath(
            new URL("../../packages/agent/src/env/node.ts", import.meta.url),
          ),
          "@eta/agent/tools$": fileURLToPath(
            new URL("../../packages/agent/src/tools/index.ts", import.meta.url),
          ),
          "@eta/agent/storage/jsonl/node$": fileURLToPath(
            new URL("../../packages/agent/src/storage/jsonl/node.ts", import.meta.url),
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
        "yaml",
        "@cf-wasm/photon/**",
        "effect",
        "effect/**",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-ai/**",
        "@eta/agent",
        "@eta/agent/**",
        "@eta/core",
        "@eta/core/**",
        "@earendil-works/chord",
        "@earendil-works/chord/**",
        "electron-updater",
        "electron-updater/**",
      ],
      neverBundle: ["electron"],
    },
  },
});
