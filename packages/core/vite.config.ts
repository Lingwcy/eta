import { publishedPiAliases } from "../../scripts/published-pi-aliases.ts";
import { globSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  resolve: {
    conditions: [],
    alias: [
      {
        find: /^@eta\/core$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      {
        find: /^@eta\/core\/(.+)$/,
        replacement: `${fileURLToPath(new URL("./src/", import.meta.url))}$1.ts`,
      },
      ...Object.entries(publishedPiAliases).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  ssr: { resolve: { conditions: [] }, noExternal: ["@eta/agent", /^@earendil-works\/chord/] },
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
