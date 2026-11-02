// Minified bundle whose map has names and mappings but no sourcesContent.
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
  sourcemap: "linked",
  sourcesContent: false,
  outfile: "dist/assets/app.js",
  logLevel: "warning",
});
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
