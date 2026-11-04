// esbuild, minified: ESM modules are hoisted, the CommonJS file gets a `__commonJS` wrapper, and
// the ESM file it requires gets `__esm` and `__export`.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  absWorkingDir: here,
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "dist/assets/app.js",
  logLevel: "warning",
});
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
