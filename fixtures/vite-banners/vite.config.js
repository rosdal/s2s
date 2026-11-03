import { defineConfig } from "vite";

// Legal comments stay inline and there are no maps, so banners are the main package signal.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: { output: { comments: { legal: true } } },
  },
});
