import { createRequire } from "node:module";
import { runCli } from "./main.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

process.exitCode = await runCli(process.argv.slice(2), version);
