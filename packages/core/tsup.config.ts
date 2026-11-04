import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/fingerprint/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
});
