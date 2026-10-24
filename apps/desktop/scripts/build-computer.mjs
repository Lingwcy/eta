import { resolve } from "node:path";
import { buildNative } from "../../../packages/computer-use/scripts/build-native.mjs";

await buildNative(resolve(process.argv[2], "computer-native"));
