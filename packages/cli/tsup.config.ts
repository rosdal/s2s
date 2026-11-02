import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // No sourcemap: the published package ships only dist/, so a map would point at missing files.
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
