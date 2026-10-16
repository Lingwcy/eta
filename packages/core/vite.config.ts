import { globSync } from "node:fs";
import { relative } from "node:path";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] }, noExternal: ["@eta/agent"] },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
  pack: [
    {
      entry: Object.fromEntries(
        globSync("src/**/*.ts")
          .filter(
            (path) =>
              !path.endsWith(".test.ts") &&
              !path.endsWith("sandbox/worker.ts") &&
              !path.endsWith("codemode-worker.ts"),
          )
          .map((path) => [relative("src", path).replaceAll("\\", "/").replace(/\.ts$/, ""), path]),
      ),
      format: "esm",
      outExtensions: () => ({ js: ".mjs" }),
      dts: { generator: "tsgo" },
    },
    {
      entry: {
        worker: "src/platform/sandbox/worker.ts",
        "codemode-worker": "src/service/runtime/codemode-worker.ts",
      },
      outDir: "dist/sandbox",
      clean: false,
      format: "esm",
      outExtensions: () => ({ js: ".mjs" }),
      dts: false,
      deps: {
        alwaysBundle: [
          "@earendil-works/pi-codemode/**",
          "@earendil-works/pi-codemode",
          "quickjs-wasi",
          "quickjs-wasi/**",
          "@eta/agent/**",
          "@earendil-works/chord/**",
          "effect",
          "effect/**",
        ],
      },
    },
  ],
});
