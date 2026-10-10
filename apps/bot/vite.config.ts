import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import { defineConfig } from "vite-plus";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const workspaceAliases = Object.fromEntries(
  ["core", "agent"].flatMap((name) =>
    globSync(`packages/${name}/src/**/*.ts`, { cwd: repository })
      .map((path) => path.replaceAll("\\", "/"))
      .filter((path) => !path.endsWith(".test.ts"))
      .map((path) => [
        `@eta/${name}/${path.replace(`packages/${name}/src/`, "").replace(/\.ts$/, "")}$`,
        fileURLToPath(new URL(`../../${path}`, import.meta.url)),
      ]),
  ),
);

export default defineConfig({
  resolve: { conditions: ["source"] },
  ssr: { resolve: { conditions: ["source"] }, noExternal: ["@eta/core", "@eta/agent"] },
  test: { environment: "node", include: ["src/**/*.test.ts", "extensions/**/*.test.ts"] },
  pack: {
    entry: {
      main: "src/main.ts",
      runtime: "src/runtime.ts",
      "sandbox-worker": "../../packages/core/src/platform/sandbox/worker.ts",
    },
    format: "esm",
    outExtensions: () => ({ js: ".mjs" }),
    dts: false,
    inputOptions: {
      resolve: {
        alias: {
          ...workspaceAliases,
          "@eta/core$": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
          "@eta/agent$": fileURLToPath(
            new URL("../../packages/agent/src/index.ts", import.meta.url),
          ),
          "@eta/agent/env$": fileURLToPath(
            new URL("../../packages/agent/src/env/index.ts", import.meta.url),
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
    deps: {
      neverBundle: ["zlib-sync"],
      alwaysBundle: [
        "@eta/core",
        "@eta/core/**",
        "@eta/agent",
        "@eta/agent/**",
        "effect",
        "effect/**",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-ai/**",
        "@earendil-works/chord",
        "@earendil-works/chord/**",
        "@cf-wasm/photon/**",
        "hono",
        "hono/**",
        "@hono/node-server",
        "yaml",
        "discord.js",
        "discord.js/**",
      ],
    },
  },
});
