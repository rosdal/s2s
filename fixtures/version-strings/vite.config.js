import { defineConfig } from "vite";

// No source maps and no legal comments: only version strings inside the code are left to find.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: { output: { comments: { legal: false } } },
  },
});
