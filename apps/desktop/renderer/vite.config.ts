import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.ETA_WEB_PORT ?? 5173);

export default defineConfig({
  root,
  base: "./",
  plugins: [tailwindcss(), react()],
  server: { host: "127.0.0.1", port, strictPort: true },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@eta/core": fileURLToPath(new URL("../../../packages/core/src", import.meta.url)),
    },
  },
  build: { outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)), emptyOutDir: true },
});
