// Remove the sourceMappingURL comment from the lazy chunk, so its map is only found by probing.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "dist", "assets");
const lazy = readdirSync(dir).find((file) => file.startsWith("lazy-") && file.endsWith(".js"));
if (!lazy) throw new Error("lazy chunk not found");
const file = path.join(dir, lazy);
const stripped = readFileSync(file, "utf8").replace(/\n?\/\/# sourceMappingURL=.*\s*$/, "\n");
writeFileSync(file, stripped);
