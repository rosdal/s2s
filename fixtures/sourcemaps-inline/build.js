// Bundle with the map inlined as a data: URL, so no .map file exists on the server.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  absWorkingDir: here,
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  sourcemap: "inline",
  outfile: "dist/assets/app.js",
  logLevel: "warning",
});
copyFileSync(path.join(here, "index.html"), path.join(dist, "index.html"));
