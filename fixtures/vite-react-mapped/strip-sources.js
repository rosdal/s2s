// Drop sourcesContent from every map Vite wrote, leaving partial maps.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const assets = path.join(import.meta.dirname, "dist", "assets");
for (const name of readdirSync(assets).filter((n) => n.endsWith(".map"))) {
  const file = path.join(assets, name);
  const map = JSON.parse(readFileSync(file, "utf8"));
  delete map.sourcesContent;
  writeFileSync(file, JSON.stringify(map));
}
