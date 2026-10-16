import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
await copyFile(require.resolve("quickjs-wasi/quickjs.wasm"), resolve(output, "quickjs.wasm"));
