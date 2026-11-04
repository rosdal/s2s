// A plain script run through javascript-obfuscator's default preset, with a fixed seed so the
// output is the same on every build.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import JavaScriptObfuscator from "javascript-obfuscator";

const here = import.meta.dirname;
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "assets"), { recursive: true });
const source = readFileSync(path.join(here, "src", "app.js"), "utf8");
const result = JavaScriptObfuscator.obfuscate(source, { seed: 1 });
writeFileSync(path.join(dist, "assets", "app.js"), result.getObfuscatedCode());
writeFileSync(path.join(dist, "index.html"), readFileSync(path.join(here, "index.html")));
