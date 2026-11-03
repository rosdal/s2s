// Records npm registry answers for the Stage 3 tests, so they never touch the network.
//
//   node fixtures/registry/record.mjs react react-dom lodash ...
//
// Each package gets `<name>.json` (the packument, trimmed to what s2s reads: stable versions,
// their dependency names and publish times) and `<name>.downloads.json`. A 404 is recorded as
// `null`, so "this package does not exist" is part of the recording too.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const encode = (name) =>
  name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
const stable = (version) => /^\d+\.\d+\.\d+$/.test(version);

async function get(url) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

for (const name of process.argv.slice(2)) {
  const doc = await get(`https://registry.npmjs.org/${encode(name)}`);
  let packument = null;
  if (doc) {
    const versions = {};
    const time = {};
    for (const [version, meta] of Object.entries(doc.versions ?? {})) {
      if (!stable(version)) continue;
      versions[version] = { dependencies: meta.dependencies ?? {} };
      if (doc.time?.[version]) time[version] = doc.time[version];
    }
    packument = {
      name: doc.name,
      "dist-tags": { latest: doc["dist-tags"]?.latest },
      versions,
      time,
    };
  }
  const downloads = await get(`https://api.npmjs.org/downloads/point/last-week/${name}`);
  writeFileSync(path.join(here, `${encode(name)}.json`), `${JSON.stringify(packument)}\n`);
  writeFileSync(
    path.join(here, `${encode(name)}.downloads.json`),
    `${JSON.stringify(downloads ? { downloads: downloads.downloads } : null)}\n`,
  );
  console.log(`${name}: ${packument ? Object.keys(packument.versions).length : 0} versions`);
}
