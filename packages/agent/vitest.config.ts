import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

import manifest from "./package.json" with { type: "json" };

const aliases = Object.entries(manifest.exports).flatMap(([name, entry]) =>
	typeof entry === "object" && "source" in entry
		? [{ find: new RegExp(`^@earendil-works/pi-durable${name.slice(1)}$`), replacement: fileURLToPath(new URL(entry.source, import.meta.url)) }]
		: [],
);

export default defineConfig({
	test: {
		environment: "node",
		// These live-provider probes depend on Pi's sibling ai sources and private OAuth test helper.
		// Run in workerd by their own config: `npm run test:workers`.
		exclude: [...configDefaults.exclude, "test-workers/**", "test/provider-session-cache-e2e.test.ts", "test/system-order-cache-e2e.test.ts"],
		setupFiles: ["./test/setup-document-retention.ts"],
	},
	resolve: {
		conditions: ["source"],
		alias: aliases,
	},
	ssr: { resolve: { conditions: ["source"] } },
});
