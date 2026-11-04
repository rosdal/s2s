import { defineConfig } from "vite";

export default defineConfig({
  // Every asset becomes its own hashed file, never a data: URL.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
});
