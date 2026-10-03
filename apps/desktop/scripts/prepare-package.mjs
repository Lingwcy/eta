import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const desktop = new URL("../", import.meta.url);
const staging = new URL("dist/package/", desktop);
const manifest = JSON.parse(await readFile(new URL("package.json", desktop), "utf8"));

await rm(staging, { recursive: true, force: true });
await mkdir(new URL("dist/", staging), { recursive: true });
for (const directory of ["electron", "ui"]) {
  await cp(new URL(`dist/${directory}/`, desktop), new URL(`dist/${directory}/`, staging), {
    recursive: true,
  });
}
// Runtime dependencies are bundled; the installer must not traverse the development workspace.
await writeFile(
  new URL("package.json", staging),
  JSON.stringify(
    {
      name: "eta",
      productName: "Eta",
      version: manifest.version,
      description: "Eta desktop coding agent",
      private: true,
      main: manifest.main,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared desktop application: ${fileURLToPath(staging)}`);
