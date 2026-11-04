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
  // core is private, so it is bundled in from source; its dependencies stay external and are
  // listed in this package's dependencies.
  noExternal: ["@rosdal/s2s-core", "@rosdal/s2s-fingerprints"],
  esbuildOptions(options) {
    options.conditions = ["source"];
  },
});
