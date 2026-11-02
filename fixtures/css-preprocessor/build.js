// Vite 8 writes no CSS source maps in production builds, so this fixture uses the tools directly:
// Sass compiles the SCSS with a map, esbuild bundles the JS and its CSS Module with maps.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import * as sass from "sass";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
const assets = path.join(dist, "assets");
rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });

const scss = sass.compile(path.join(here, "src/styles/site.scss"), {
  sourceMap: true,
  sourceMapIncludeSources: true,
});
writeFileSync(path.join(assets, "site.css"), `${scss.css}\n/*# sourceMappingURL=site.css.map */\n`);
writeFileSync(path.join(assets, "site.css.map"), JSON.stringify(scss.sourceMap));

await build({
  absWorkingDir: here,
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "esm",
  sourcemap: "linked",
  outfile: "dist/assets/app.js",
  logLevel: "warning",
});
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
