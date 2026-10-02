import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      "dist/**",
      "packages/agent/test/**",
      "packages/agent/vitest*.config.ts",
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos/**",
      "dist/**",
      "packages/agent/test/**",
      "packages/agent/vitest*.config.ts",
    ],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
