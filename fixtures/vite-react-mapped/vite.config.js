import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The vite-react app with source maps; strip-sources.js then removes their sourcesContent, so the
// maps only carry names and file boundaries.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
