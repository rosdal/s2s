import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  // The CLI runs in CI straight from dist/, so core comes in from source like in @rosdal/s2s.
  noExternal: ["@rosdal/s2s-core"],
  esbuildOptions(options) {
    options.conditions = ["source"];
  },
});
