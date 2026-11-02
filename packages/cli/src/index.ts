import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const arg = process.argv[2];

if (arg === "--version" || arg === "-v") {
  console.log(version);
} else {
  console.error(`s2s ${version}: not implemented yet. Only --version works in this release.`);
  process.exitCode = 1;
}
