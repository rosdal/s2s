import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
console.log(version);
