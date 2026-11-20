import { fileURLToPath } from "node:url";

/** Published Pi packages advertise source files they do not ship. */
export const publishedPiAliases = Object.fromEntries(
  [
    ["@earendil-works/pi-telemetry/render", "pi-telemetry/dist/render.js"],
    ["@earendil-works/pi-telemetry/testing", "pi-telemetry/dist/testing/index.js"],
    ["@earendil-works/pi-telemetry", "pi-telemetry/dist/index.js"],
    ["@earendil-works/chord/context", "chord/dist/context/index.js"],
    ["@earendil-works/chord/delta", "chord/dist/delta/index.js"],
    ["@earendil-works/chord/json", "chord/dist/json.js"],
    ["@earendil-works/chord/watch", "chord/dist/watch.js"],
    ["@earendil-works/chord/output", "chord/dist/output.js"],
    ["@earendil-works/chord/compression", "chord/dist/node/compression.js"],
    ["@earendil-works/chord/sqlite/cloudflare", "chord/dist/sqlite/cloudflare.js"],
    ["@earendil-works/chord/sqlite/node", "chord/dist/sqlite/node.js"],
    ["@earendil-works/chord/sqlite", "chord/dist/sqlite/index.js"],
    ["@earendil-works/chord/telemetry-sqlite/node", "chord/dist/telemetry-sqlite/node.js"],
    ["@earendil-works/chord/telemetry-sqlite", "chord/dist/telemetry-sqlite/index.js"],
    ["@earendil-works/chord", "chord/dist/index.js"],
    ["@earendil-works/pi-schema/formats", "pi-schema/dist/formats/index.js"],
    ["@earendil-works/pi-schema", "pi-schema/dist/index.js"],
    ["@earendil-works/pi-codemode/declarations", "pi-codemode/dist/declarations.js"],
    ["@earendil-works/pi-codemode/portable", "pi-codemode/dist/portable.js"],
    ["@earendil-works/pi-codemode/source", "pi-codemode/dist/source.js"],
    ["@earendil-works/pi-codemode", "pi-codemode/dist/index.js"],
  ].map(([name, path]) => [
    name,
    fileURLToPath(
      new URL(`../packages/agent/node_modules/@earendil-works/${path}`, import.meta.url),
    ),
  ]),
);
