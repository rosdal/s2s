// A Browserify bundle of three CommonJS modules.
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import browserify from "browserify";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "assets"), { recursive: true });
writeFileSync(path.join(dist, "index.html"), readFileSync(path.join(here, "index.html")));
// Relative paths keep the bundle free of this machine's folder layout.
const bundle = browserify("./src/main.js", { basedir: here });
await new Promise((resolve, reject) => {
  const out = createWriteStream(path.join(dist, "assets", "bundle.js"));
  bundle.bundle().on("error", reject).pipe(out).on("finish", resolve);
});
